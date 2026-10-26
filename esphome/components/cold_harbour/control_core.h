#pragma once
#include <algorithm>
#include <cmath>
#include <cstdint>

namespace esphome::cold_harbour {

// Boiler primary water can serve DHW too. Only expose CH samples in a known CH phase.
class HeatingObservation {
 public:
  const char *update(uint32_t now,bool fresh,bool dhw,bool ch,float dhw_flow=NAN) {
    usable_=false;
    if(!fresh)return phase_="unknown";
    if(dhw || (std::isfinite(dhw_flow) && dhw_flow>0.5f)){dhw_seen_=true;dhw_at_=now;return phase_="domestic_hot_water";}
    if(dhw_seen_ && now-dhw_at_<120000)return phase_="settling_after_hot_water";
    if(ch){usable_=true;return phase_="space_heating";}
    return phase_="idle";
  }
  const char *phase() const {return phase_;}
  bool usable() const {return usable_;}
 private:
  uint32_t dhw_at_{0};bool dhw_seen_{false},usable_{false};const char *phase_{"unknown"};
};

// No network, JSON or ESPHome dependencies: output authority can be tested alone.
class ControlCore {
 public:
  float min_flow{35}, max_flow{52};
  bool remote_mode{false}, comfort_enabled{true}, fault{false}, ot_fresh{false};
  bool local_valid{false}, pid_valid{false};
  float local_temperature{NAN}, pid_level{0};
  uint32_t min_off_ms{180000};
  void start(uint32_t now) { last_off_=now; }
  void clear_remote() { remote_valid_=false; }
  bool accept_remote(uint32_t now,uint32_t requested_at,uint32_t lease_s,bool enabled,float flow) {
    if(!remote_mode || now-requested_at>10000 || lease_s<30 || lease_s>90 || !std::isfinite(flow) || (enabled?(flow<min_flow || flow>max_flow):flow!=0))return false;
    remote_valid_=true;remote_at_=requested_at;lease_ms_=lease_s*1000;remote_enabled_=enabled;remote_flow_=flow;return true;
  }
  bool remote_active(uint32_t now) const {return remote_mode && remote_valid_ && now-remote_at_<lease_ms_;}
  uint32_t lease_remaining(uint32_t now) const {return remote_active(now)?(lease_ms_-(now-remote_at_)+999)/1000:0;}
  bool frost_active() const {return frost_;}
  const char *mode() const {return mode_;}
  float update(uint32_t now) {
    if(!local_valid)frost_=false;
    else if(local_temperature<=7)frost_=true;
    else if(local_temperature>=9)frost_=false;
    float wanted=0;
    if(fault){mode_="Boiler fault";}
    else if(!ot_fresh){mode_="OpenTherm unavailable";}
    else if(frost_){mode_="Local frost protection";wanted=std::min(40.0f,max_flow);}
    else if(!comfort_enabled){mode_="Central heating paused";}
    else if(remote_active(now)){mode_="Cold Harbour";wanted=remote_enabled_?remote_flow_:0;}
    else if(pid_valid && std::isfinite(pid_level)){
      mode_=remote_mode?"Cold Harbour unavailable: PID":"PID";
      const float level=std::clamp(pid_level,0.0f,1.0f);
      if(level>0)wanted=min_flow+(max_flow-min_flow)*level;
    }else{mode_="No valid PID temperature";}
    if(wanted>0 && !frost_ && last_flow_==0 && now-last_off_<min_off_ms){wanted=0;mode_="Minimum off interval";}
    if(last_flow_>0 && wanted==0)last_off_=now;
    last_flow_=wanted;return wanted;
  }
 private:
  bool remote_valid_{false},remote_enabled_{false},frost_{false};
  uint32_t remote_at_{0},lease_ms_{0},last_off_{0};
  float remote_flow_{0},last_flow_{0};
  const char *mode_{"Starting"};
};
}
