#pragma once
#include "esphome/core/component.h"
#include "esphome/components/api/api_server.h"
#include "esphome/components/output/float_output.h"
#include "esphome/components/sensor/sensor.h"
#include "esphome/components/pid/pid_climate.h"
#include "esphome/components/json/json_util.h"
#include "esphome/components/text/text.h"
#include "esphome/components/opentherm/hub.h"
#include "esphome/core/preferences.h"
#include "control_core.h"
#include "connection_settings.h"
#include "frame_capture.h"
#include <string>
#include <memory>
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

namespace esphome::cold_harbour {
class ColdHarbour;
class ServerURLText : public text::Text {
 public:
  void set_parent(ColdHarbour *parent){parent_=parent;}
 protected:
  void control(const std::string &value) override;
  ColdHarbour *parent_{nullptr};
};
class PairingKeyText : public text::Text {
 public:
  void set_parent(ColdHarbour *parent){parent_=parent;}
 protected:
  void control(const std::string &value) override;
  ColdHarbour *parent_{nullptr};
};
class ColdHarbour : public PollingComponent {
 public:
  void setup() override;
  void update() override;
  void dump_config() override;
  void on_shutdown() override {if(flow_output_)flow_output_->set_level(0);}
  float get_setup_priority() const override {return setup_priority::AFTER_CONNECTION;}
  void set_flow_output(output::FloatOutput *p){flow_output_=p;}
  void set_pid_climate(pid::PIDClimate *p){pid_=p;}
  void set_local_temperature(sensor::Sensor *p){local_=p;}
  void set_ha_temperature(sensor::Sensor *p){ha_=p;}
  void set_boiler_temperature(sensor::Sensor *p){boiler_=p;}
  void set_api_id(api::APIServer *p){api_=p;}
  void set_opentherm_id(opentherm::OpenthermHub *p){ot_hub_=p;}
  void set_server_url(const std::string &v){connection_.set_url(v);}
  void set_shared_key(const std::string &v){connection_.set_key(v);}
  void set_server_url_text(text::Text *p){url_text_=p;}
  void set_pairing_key_text(text::Text *p){key_text_=p;}
  bool configure_server_url(const std::string &value);
  bool configure_shared_key(const std::string &value);
  const std::string &server_url() const{return connection_.url();}
  bool pairing_key_configured() const{return !connection_.key().empty();}
  std::string connection_setup_status() const;
  void set_device_id(const std::string &v){device_id_=v;}
  void set_min_flow(float v){core_.min_flow=v;}
  void set_max_flow(float v){core_.max_flow=v;}
  void set_ha_stale_after(uint32_t v){ha_stale_ms_=v;}
  void set_remote_mode(bool enabled){if(core_.remote_mode!=enabled){core_.remote_mode=enabled;core_.clear_remote();reset_pid_();}}
  void set_comfort_enabled(bool enabled){if(core_.comfort_enabled!=enabled){core_.comfort_enabled=enabled;reset_pid_();}}
  void set_pid_level(float value){core_.pid_level=value;pid_at_=millis();pid_seen_=true;}
  void set_fault(bool value){core_.fault=value;}
  void set_ota_in_progress(bool value){ota_active_=value;if(value){core_.clear_remote();flow_=0;flow_output_->set_level(0);}reset_pid_();}
  void set_metric(const std::string &name,float value){for(auto &metric:metrics_)if(name==metric.name){metric.value=value;metric.at=millis();metric.seen=true;return;}}
  void set_flags(bool flame,bool ch,bool dhw){flame_=flame;ch_active_=ch;dhw_active_=dhw;}
  float pid_temperature() const;
  std::string temperature_source() const;
  std::string effective_mode() const {return core_.mode();}
  float requested_flow() const{return flow_;}
  bool remote_active() const{return core_.remote_active(millis()) && core_.comfort_enabled && !core_.fault && core_.ot_fresh && !core_.frost_active();}
  bool frost_active() const{return core_.frost_active();}
  float lease_remaining() const{return core_.lease_remaining(millis());}
  float exchange_failures() const{return failures_;}
  float exchange_age() const{return exchange_seen_?(millis()-exchange_at_)/1000.0f:NAN;}
  float opentherm_age() const{return ot_seen_?(millis()-ot_at_)/1000.0f:NAN;}
  void set_frame_capture(bool enabled){if(enabled)capture_.start(millis());else capture_.stop();}
  bool frame_capture_active() const{return capture_.active(millis());}
  void capture_frame(bool tx,uint8_t type,uint8_t id,uint8_t high,uint8_t low){capture_.record(millis(),tx,type,id,uint16_t(high)<<8|low);}
 private:
  struct Job {char url[256];char body[6144];uint32_t sequence;uint32_t started_at;uint32_t generation;uint32_t trace_sequence;};
  struct Result {char body[1536];size_t size;int status;uint32_t sequence;uint32_t started_at;uint32_t generation;uint32_t trace_sequence;bool overflow;};
  struct Metric {const char *name;float value{NAN};uint32_t at{0};bool seen{false};};
  Metric metrics_[8]={{"return_c"},{"modulation_pct"},{"pressure_bar"},{"burner_starts"},{"burner_hours"},{"dhw_flow_l_min"},{"dhw_temperature_c"},{"dhw_setpoint_c"}};
  static void worker_(void *arg);
  void exchange_();
  bool start_worker_();
  bool save_connection_(const ConnectionSettings &next);
  void connection_changed_();
  bool accept_response_(const Result &result);
  std::string hmac_(const std::string &payload) const;
  void reset_pid_(){if(pid_)pid_->reset_integral_term();pid_seen_=false;}
  ControlCore core_;
  HeatingObservation observation_;
  ConnectionSettings connection_;
  FrameCapture capture_;
  ESPPreferenceObject connection_pref_;
  text::Text *url_text_{nullptr},*key_text_{nullptr};
  output::FloatOutput *flow_output_{nullptr};pid::PIDClimate *pid_{nullptr};
  sensor::Sensor *local_{nullptr},*ha_{nullptr},*boiler_{nullptr};api::APIServer *api_{nullptr};
  opentherm::OpenthermHub *ot_hub_{nullptr};
  std::string device_id_,boot_id_,request_id_,last_mode_,last_source_,configuration_error_;
  QueueHandle_t jobs_{nullptr},results_{nullptr};TaskHandle_t task_{nullptr};
  std::unique_ptr<Job> worker_job_;
  uint32_t local_at_{0},ha_at_{0},ot_at_{0},pid_at_{0},exchange_at_{0},sequence_{0},failures_{0},ha_stale_ms_{600000};
  bool local_seen_{false},ha_seen_{false},ot_seen_{false},pid_seen_{false},busy_{false},exchange_seen_{false},was_remote_{false};
  bool flame_{false},ch_active_{false},dhw_active_{false},ota_active_{false};
  float flow_{0};
};
}
