#include "cold_harbour.h"
#include "esphome/core/log.h"
#include "esphome/components/network/util.h"
#include "esp_http_client.h"
#include "esp_crt_bundle.h"
#include "esp_random.h"
#include "esp_system.h"
#include "mbedtls/md.h"
#include <cstdio>
#include <cstring>
#include <memory>
#include <new>

namespace esphome::cold_harbour {
static const char *const TAG="cold_harbour";
static std::string random_hex(size_t bytes){char out[33]{};for(size_t i=0;i<bytes;i++){const auto r=esp_random();snprintf(out+i*2,3,"%02x",unsigned(r&255));}return out;}
void ColdHarbour::setup(){
  core_.start(millis());flow_output_->set_level(0);boot_id_=random_hex(16);
  ot_hub_->add_on_before_send_callback([this](opentherm::OpenthermData &x){capture_frame(true,x.type,x.id,x.valueHB,x.valueLB);});
  ot_hub_->add_on_before_process_response_callback([this](opentherm::OpenthermData &x){capture_frame(false,x.type,x.id,x.valueHB,x.valueLB);});
  connection_pref_=global_preferences->make_preference<StoredConnection>(fnv1_hash("cold_harbour.connection.v1/"+device_id_));
  StoredConnection saved{};
  if(connection_pref_.load(&saved) && !connection_.restore(saved))ESP_LOGW(TAG,"Stored connection settings are invalid; keeping firmware defaults");
  if(url_text_)url_text_->publish_state(connection_.url());
  if(key_text_)key_text_->publish_state("");
  local_->add_on_state_callback([this](float){local_seen_=true;local_at_=millis();});
  ha_->add_on_state_callback([this](float){ha_seen_=true;ha_at_=millis();});
  boiler_->add_on_state_callback([this](float value){if(std::isfinite(value)){ot_seen_=true;ot_at_=millis();}});
  set_interval("exchange",30000,[this](){exchange_();});
  set_timeout("first_exchange",10000,[this](){exchange_();});
}
bool ColdHarbour::start_worker_(){
  if(task_)return true;
  if(!worker_job_)worker_job_.reset(new(std::nothrow) Job{});
  if(!worker_job_){ESP_LOGW(TAG,"HTTP snapshot unavailable; retry later");return false;}
  if(!jobs_)jobs_=xQueueCreate(1,sizeof(Job));
  if(!results_)results_=xQueueCreate(1,sizeof(Result));
  if(jobs_ && results_ && xTaskCreate(worker_,"cold_harbour_http",16384,this,1,&task_)==pdPASS)return true;
  task_=nullptr;ESP_LOGE(TAG,"Network worker unavailable; local PID remains available");return false;
}
bool ColdHarbour::save_connection_(const ConnectionSettings &next){
  configuration_error_.clear();
  if(next.generation()==connection_.generation())return true;
  const auto saved=next.stored();
  if(!connection_pref_.save(&saved)||!global_preferences->sync()){
    configuration_error_="Could not save connection settings; retry";
    core_.clear_remote();reset_pid_();ESP_LOGW(TAG,"Could not save connection settings");return false;
  }
  connection_=next;connection_changed_();return true;
}
void ColdHarbour::connection_changed_(){
  core_.clear_remote();reset_pid_();exchange_seen_=false;
  // Keep busy_ until the single old request finishes. Its generation is discarded.
  set_timeout("connection_changed",1000,[this](){exchange_();});
  ESP_LOGI(TAG,"Connection settings updated; waiting for a fresh authenticated command");
}
bool ColdHarbour::configure_server_url(const std::string &value){
  auto next=connection_;
  if(!next.set_url(value)){configuration_error_="Invalid base HTTP(S) URL; previous address retained";ESP_LOGW(TAG,"Invalid server URL; settings unchanged");return false;}
  return save_connection_(next);
}
bool ColdHarbour::configure_shared_key(const std::string &value){
  auto next=connection_;
  if(!next.set_key(value)){configuration_error_="Key must be 64 lowercase hex characters, or blank to clear";ESP_LOGW(TAG,"Invalid pairing key format; settings unchanged");return false;}
  return save_connection_(next);
}
std::string ColdHarbour::connection_setup_status() const{
  if(!configuration_error_.empty())return configuration_error_;
  if(connection_.url().empty())return "Server address required";
  if(connection_.key().empty())return "Pairing key required";
  if(exchange_seen_ && millis()-exchange_at_<90000)return "Configured; signed exchanges verified";
  return "Configured; awaiting signed exchanges";
}
void ServerURLText::control(const std::string &value){parent_->configure_server_url(value);publish_state(parent_->server_url());}
void PairingKeyText::control(const std::string &value){parent_->configure_shared_key(value);publish_state("");}
float ColdHarbour::pid_temperature() const{
  const auto now=millis();
  if(ha_seen_ && api_->is_connected_with_state_subscription() && now-ha_at_<ha_stale_ms_ && std::isfinite(ha_->state) && ha_->state>=-20 && ha_->state<=50)return ha_->state;
  if(local_seen_ && now-local_at_<90000 && std::isfinite(local_->state) && local_->state>=-30 && local_->state<=60)return local_->state;
  return NAN;
}
std::string ColdHarbour::temperature_source() const{
  if(!std::isfinite(pid_temperature()))return "Unavailable";
  const auto now=millis();
  return ha_seen_ && api_->is_connected_with_state_subscription() && now-ha_at_<ha_stale_ms_ && std::isfinite(ha_->state) && ha_->state>=-20 && ha_->state<=50?"Home Assistant average":"Local Dallas probe";
}
void ColdHarbour::update(){
  if(ota_active_){flow_=0;flow_output_->set_level(0);return;}
  Result result{};
  if(results_ && xQueueReceive(results_,&result,0)==pdTRUE){busy_=false;if(connection_.accepts_generation(result.generation)){if(accept_response_(result))capture_.acknowledge(result.trace_sequence);else failures_++;}}
  const auto now=millis();
  const auto source=temperature_source();
  const bool remote=core_.remote_active(now);
  if(source!=last_source_ || remote!=was_remote_){reset_pid_();last_source_=source;was_remote_=remote;}
  core_.local_valid=local_seen_ && now-local_at_<90000 && std::isfinite(local_->state) && local_->state>=-30 && local_->state<=60;
  core_.local_temperature=local_->state;
  core_.ot_fresh=ot_seen_ && now-ot_at_<90000;
  float dhw_flow=NAN;
  for(const auto &metric:metrics_)if(std::strcmp(metric.name,"dhw_flow_l_min")==0 && metric.seen && now-metric.at<90000)dhw_flow=metric.value;
  observation_.update(now,core_.ot_fresh,dhw_active_,ch_active_,dhw_flow);
  core_.pid_valid=std::isfinite(pid_temperature()) && pid_seen_ && now-pid_at_<20000 && pid_->mode==climate::CLIMATE_MODE_HEAT;
  flow_=core_.update(now);
  flow_output_->set_level(flow_/100.0f);
  if(last_mode_!=core_.mode()){last_mode_=core_.mode();ESP_LOGI(TAG,"Control: %s",last_mode_.c_str());}
}
std::string ColdHarbour::hmac_(const std::string &payload) const{
  unsigned char digest[32]{};char hex[65]{};
  const auto *info=mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  const auto &key=connection_.key();
  if(!info || mbedtls_md_hmac(info,reinterpret_cast<const unsigned char*>(key.data()),key.size(),reinterpret_cast<const unsigned char*>(payload.data()),payload.size(),digest)!=0)return "";
  for(size_t i=0;i<32;i++){snprintf(hex+i*2,3,"%02x",unsigned(digest[i]));}
  return hex;
}
void ColdHarbour::exchange_(){
  if(!connection_.ready() || busy_ || ota_active_ || !network::is_connected() || !start_worker_())return;
  request_id_=random_hex(8);++sequence_;
  capture_.prune(millis());
  const uint32_t trace_sequence=capture_.size()?capture_.at(capture_.size()-1).sequence:0;
  const std::string payload=json::build_json([this](JsonObject root){
    root["v"]=1;root["device_id"]=device_id_;root["boot_id"]=boot_id_;root["request_id"]=request_id_;root["sequence"]=sequence_;root["mode"]=core_.remote_mode?"Cold Harbour":"PID";
    JsonObject t=root["telemetry"].to<JsonObject>();
    const auto put=[&t](const char *key,float value){if(std::isfinite(value))t[key]=value;};
    if(core_.local_valid)put("local_temperature_c",local_->state);
    put("pid_temperature_c",pid_temperature());put("pid_target_c",pid_->target_temperature);put("pid_output",std::clamp(core_.pid_level,0.0f,1.0f));put("requested_flow_c",flow_);
    if(core_.ot_fresh){put("flow_c",boiler_->state);for(const auto &m:metrics_)if(m.seen && millis()-m.at<90000)put(m.name,m.value);}
    if(observation_.usable()){
      put("ch_flow_c",boiler_->state);
      for(const auto &m:metrics_)if(m.seen && millis()-m.at<90000){
        if(std::strcmp(m.name,"return_c")==0)put("ch_return_c",m.value);
        if(std::strcmp(m.name,"modulation_pct")==0)put("ch_modulation_pct",m.value);
      }
    }
    put("protocol_revision",2);put("min_flow_c",core_.min_flow);put("max_flow_c",core_.max_flow);put("lease_remaining_s",lease_remaining());
    t["comfort_enabled"]=core_.comfort_enabled;t["pid_available"]=core_.pid_valid;t["heating_sample_valid"]=observation_.usable();t["thermal_context"]=observation_.phase();t["pid_source"]=temperature_source();
#ifdef USE_WIFI
    t["network_transport"]="wifi";
#else
    t["network_transport"]="ethernet";
#endif
    put("opentherm_age_s",opentherm_age());put("free_heap_bytes",esp_get_free_heap_size());put("exchange_failures",failures_);
    if(core_.ot_fresh){t["flame"]=flame_;t["ch_active"]=ch_active_;t["dhw_active"]=dhw_active_;t["boiler_fault"]=core_.fault;}
    t["frost_active"]=core_.frost_active();t["remote_active"]=remote_active();t["effective_mode"]=core_.mode();
    JsonObject trace=root["opentherm"].to<JsonObject>();const auto now=millis();
    trace["active"]=capture_.active(now);trace["remaining_s"]=capture_.remaining(now);trace["overwritten"]=capture_.overwritten();
    trace["control_supported"]=true;trace["last_control_id"]=capture_.last_control_id();
    JsonArray frames=trace["frames"].to<JsonArray>();
    for(size_t i=0;i<capture_.size();i++){const auto &f=capture_.at(i);JsonArray row=frames.add<JsonArray>();row.add(f.sequence);row.add(uint32_t(now-f.at));row.add(f.tx?1:0);row.add(f.type);row.add(f.id);row.add(f.data);}
  });
  const std::string signature=hmac_(payload);
  const std::string body=json::build_json([&](JsonObject root){root["payload"]=payload;root["signature"]=signature;});
  // Keep the larger optional trace snapshot off the ESP main-loop stack.
  auto job=std::unique_ptr<Job>(new(std::nothrow) Job{});const std::string url=connection_.url()+"/v1/exchange";
  if(!job || signature.size()!=64 || body.size()>=sizeof(job->body) || url.size()>=sizeof(job->url)){failures_++;return;}
  memcpy(job->body,body.c_str(),body.size()+1);memcpy(job->url,url.c_str(),url.size()+1);job->sequence=sequence_;job->started_at=millis();job->generation=connection_.generation();job->trace_sequence=trace_sequence;
  busy_=xQueueSend(jobs_,job.get(),0)==pdTRUE;
}
bool ColdHarbour::accept_response_(const Result &result){
  if(!connection_.accepts_generation(result.generation) || result.sequence!=sequence_ || result.status!=200 || result.overflow || result.size==0 || millis()-result.started_at>10000)return false;
  bool accepted=false;
  json::parse_json(std::string(result.body,result.size),[&](JsonObject envelope)->bool{
    if(!envelope["payload"].is<const char*>() || !envelope["signature"].is<const char*>())return false;
    const std::string payload=envelope["payload"].as<std::string>(),signature=envelope["signature"].as<std::string>(),expected=hmac_(payload);
    if(signature.size()!=64 || expected.size()!=64)return false;
    unsigned difference=0;for(size_t i=0;i<64;i++)difference|=unsigned(signature[i]^expected[i]);if(difference)return false;
    return json::parse_json(payload,[&](JsonObject root)->bool{
      if(root["v"].as<int>()!=1 || root["device_id"].as<std::string>()!=device_id_ || root["boot_id"].as<std::string>()!=boot_id_ || root["request_id"].as<std::string>()!=request_id_ || !root["sequence"].is<uint32_t>() || root["sequence"].as<uint32_t>()!=sequence_)return false;
      const std::string authority=root["authority"].as<std::string>();
      if(authority=="pid"){core_.clear_remote();accepted=true;}
      // A signed observation acknowledges telemetry without renewing the command.
      else if(authority=="observe"){accepted=true;}
      else if(authority=="remote" && root["enabled"].is<bool>() && root["lease_s"].is<uint32_t>() && root["flow_c"].is<float>())accepted=core_.accept_remote(millis(),result.started_at,root["lease_s"].as<uint32_t>(),root["enabled"].as<bool>(),root["flow_c"].as<float>());
      if(accepted){
        exchange_seen_=true;exchange_at_=millis();
        if((authority=="pid"||authority=="observe")&&root["diagnostic_capture"].is<JsonObject>()){
          JsonObject command=root["diagnostic_capture"].as<JsonObject>();
          if(command["duration_s"].is<uint32_t>())capture_.command(command["id"].as<std::string>(),command["action"].as<std::string>(),command["duration_s"].as<uint32_t>(),millis());
        }
      }return accepted;
    });
  });return accepted;
}
void ColdHarbour::worker_(void *arg){
  auto *self=static_cast<ColdHarbour*>(arg);auto *job=self->worker_job_.get();
  for(;;){
    if(xQueueReceive(self->jobs_,job,portMAX_DELAY)!=pdTRUE)continue;
    Result result{};result.sequence=job->sequence;result.started_at=job->started_at;result.generation=job->generation;result.trace_sequence=job->trace_sequence;
    esp_http_client_config_t config{};config.url=job->url;config.method=HTTP_METHOD_POST;config.timeout_ms=1500;config.disable_auto_redirect=true;config.buffer_size=512;config.buffer_size_tx=512;config.crt_bundle_attach=esp_crt_bundle_attach;config.user_data=&result;
    config.event_handler=[](esp_http_client_event_t *event)->esp_err_t{
      auto *r=static_cast<Result*>(event->user_data);
      if(event->event_id==HTTP_EVENT_ON_DATA){const size_t n=event->data_len;if(n>sizeof(r->body)-1-r->size){r->overflow=true;return ESP_FAIL;}memcpy(r->body+r->size,event->data,n);r->size+=n;r->body[r->size]=0;}return ESP_OK;
    };
    auto client=esp_http_client_init(&config);
    if(client){esp_http_client_set_header(client,"Content-Type","application/json");esp_http_client_set_post_field(client,job->body,strlen(job->body));if(esp_http_client_perform(client)==ESP_OK)result.status=esp_http_client_get_status_code(client);esp_http_client_cleanup(client);}
    xQueueOverwrite(self->results_,&result);
  }
}
void ColdHarbour::dump_config(){ESP_LOGCONFIG(TAG,"Cold Harbour controller: %s; bounded flow %.1f–%.1f C; 30 s telemetry; 90 s maximum lease",device_id_.c_str(),core_.min_flow,core_.max_flow);}
}
