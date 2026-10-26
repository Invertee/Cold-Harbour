#pragma once
#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <string>

namespace esphome::cold_harbour {
// Main-loop-only ring. The HTTP worker receives an immutable JSON snapshot.
class FrameCapture {
 public:
  struct Frame {uint32_t sequence,at;uint16_t data;uint8_t type,id;bool tx;};
  static constexpr size_t CAPACITY=64;
  void start(uint32_t now){started_=now;enabled_=true;head_=count_=0;overwritten_=0;}
  void stop(){enabled_=false;}
  bool active(uint32_t now) const{return enabled_&&uint32_t(now-started_)<300000;}
  uint32_t remaining(uint32_t now) const{return active(now)?(300000-uint32_t(now-started_)+999)/1000:0;}
  bool command(const std::string &id,const std::string &action,uint32_t duration,uint32_t now){
    if(id.size()!=16)return false;
    for(char c:id)if(!((c>='0'&&c<='9')||(c>='a'&&c<='f')))return false;
    if(!((action=="start"&&duration==300)||(action=="stop"&&duration==0)))return false;
    if(id==last_control_id_.data())return true;
    if(action=="start")start(now);else stop();
    std::memcpy(last_control_id_.data(),id.c_str(),17);return true;
  }
  const char *last_control_id() const{return last_control_id_.data();}
  void record(uint32_t now,bool tx,uint8_t type,uint8_t id,uint16_t data){
    if(!active(now)||sequence_==UINT32_MAX)return;
    // Older YAMLs may still register the same hooks as the automatic callbacks.
    if(count_){const auto &last=at(count_-1);if(uint32_t(now-last.at)<5&&last.tx==tx&&last.type==type&&last.id==id&&last.data==data)return;}
    if(count_==CAPACITY){head_=(head_+1)%CAPACITY;--count_;++overwritten_;}
    frames_[(head_+count_)%CAPACITY]={++sequence_,now,data,type,id,tx};++count_;
  }
  void prune(uint32_t now){while(count_&&uint32_t(now-at(0).at)>90000){head_=(head_+1)%CAPACITY;--count_;++overwritten_;}}
  void acknowledge(uint32_t sequence){while(count_&&at(0).sequence<=sequence){head_=(head_+1)%CAPACITY;--count_;}}
  size_t size() const{return count_;}
  const Frame &at(size_t index) const{return frames_[(head_+index)%CAPACITY];}
  uint32_t overwritten() const{return overwritten_;}
 private:
  std::array<Frame,CAPACITY> frames_{};
  std::array<char,17> last_control_id_{};
  size_t head_{0},count_{0};
  uint32_t started_{0},sequence_{0},overwritten_{0};bool enabled_{false};
};
}
