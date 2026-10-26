#include "../esphome/components/cold_harbour/control_core.h"
#include "../esphome/components/cold_harbour/connection_settings.h"
#include "../esphome/components/cold_harbour/frame_capture.h"
#include <cassert>
#include <cstring>
#include <iostream>
using esphome::cold_harbour::ControlCore;
using esphome::cold_harbour::HeatingObservation;
using esphome::cold_harbour::ConnectionSettings;
ControlCore ready(){ControlCore core;core.min_off_ms=0;core.start(0);core.ot_fresh=true;core.local_valid=true;core.local_temperature=18;core.pid_valid=true;core.pid_level=.5;return core;}
int main(){
  esphome::cold_harbour::FrameCapture capture;
  capture.record(0,true,0,25,0);assert(capture.size()==0);
  capture.start(1000);assert(capture.active(1000));assert(capture.remaining(1000)==300);
  for(uint32_t n=0;n<65;n++)capture.record(1000+n*10,true,0,25,0x2a80);
  assert(capture.size()==64);assert(capture.overwritten()==1);assert(capture.at(0).sequence==2);
  capture.acknowledge(32);assert(capture.size()==33);assert(capture.at(0).sequence==33);
  capture.start(2000);capture.record(2001,false,4,25,0x2a80);capture.acknowledge(65);assert(capture.size()==1);assert(capture.at(0).sequence==66);
  assert(capture.active(301999));assert(!capture.active(302000));capture.record(302001,true,0,25,0);assert(capture.size()==1);capture.prune(302001);assert(capture.size()==0);
  const uint32_t capture_before=0xfffff000;capture.start(capture_before);capture.record(capture_before+5,false,4,25,25);capture.prune(capture_before+30000);assert(capture.size()==1);assert(capture.active(capture_before+299999));assert(!capture.active(capture_before+300000));
  capture.stop();capture.record(capture_before+20,true,0,25,0);assert(capture.size()==1);
  esphome::cold_harbour::FrameCapture direct;
  assert(!direct.command("bad","start",300,100));assert(!direct.command("0123456789abcdef","start",600,100));assert(!direct.active(100));
  assert(direct.command("0123456789abcdef","start",300,100));assert(direct.remaining(100)==300);
  assert(direct.command("0123456789abcdef","start",300,200000));assert(direct.remaining(200000)==101);assert(!direct.active(300100));
  assert(direct.command("1123456789abcdef","start",300,400000));assert(direct.command("2123456789abcdef","stop",0,400001));assert(!direct.active(400001));
  direct.start(500000);direct.record(500001,true,0,25,10);direct.record(500002,true,0,25,10);assert(direct.size()==1);direct.record(500041,true,0,25,10);assert(direct.size()==2);
  ConnectionSettings connection;assert(!connection.ready());
  assert(connection.set_url("http://192.168.1.20:8102/"));assert(connection.url()=="http://192.168.1.20:8102");
  const auto url_generation=connection.generation();assert(connection.set_url("http://192.168.1.20:8102"));assert(connection.generation()==url_generation);
  assert(connection.set_key(std::string(64,'a')));assert(connection.ready());assert(!connection.accepts_generation(url_generation));
  const auto configured_generation=connection.generation();
  for(const auto &bad:{"ftp://host","http://","http://user:pass@host","http://host/path","http://host?x=1","http://host#secret","http://host:0","http://host:65536","http://host:bad","http://host\\path","http://host\n","http://host:"})assert(!connection.set_url(bad));
  assert(!connection.set_key(std::string(64,'A')));assert(!connection.set_key(std::string(63,'a')));assert(connection.generation()==configured_generation);assert(connection.ready());
  auto stored=connection.stored();ConnectionSettings rebooted;assert(rebooted.restore(stored));assert(rebooted.ready());assert(rebooted.url()==connection.url());assert(rebooted.key()==connection.key());
  assert(connection.set_url("https://heating.example:443"));assert(!connection.accepts_generation(configured_generation));assert(connection.ready());
  assert(connection.set_url("http://192.168.1.20:8102"));assert(!connection.accepts_generation(configured_generation));
  assert(connection.set_url("http://[fd00::1]:8102"));assert(connection.ready());assert(!connection.set_url("http://[fd00::1]:70000"));
  assert(!connection.set_url("http://"+std::string(231,'a')));
  assert(connection.set_key(""));assert(!connection.ready());assert(rebooted.restore(connection.stored()));assert(!rebooted.ready());assert(rebooted.key().empty());
  stored.magic=0;assert(!rebooted.restore(stored));assert(rebooted.key().empty());
  stored=connection.stored();stored.key[64]='x';assert(!rebooted.restore(stored));
  stored=connection.stored();std::strcpy(stored.url,"http://different-host:8102");std::strcpy(stored.key,"invalid");
  const auto retained_url=rebooted.url();assert(!rebooted.restore(stored));assert(rebooted.url()==retained_url);assert(rebooted.key().empty());
  assert(connection.set_url(""));assert(connection.url().empty());assert(!connection.ready());
  HeatingObservation observation;
  assert(!std::strcmp(observation.update(1000,true,false,true),"space_heating"));assert(observation.usable());
  assert(!std::strcmp(observation.update(2000,true,true,true),"domestic_hot_water"));assert(!observation.usable());
  assert(!std::strcmp(observation.update(121999,true,false,true),"settling_after_hot_water"));assert(!observation.usable());
  assert(!std::strcmp(observation.update(122000,true,false,true),"space_heating"));assert(observation.usable());
  assert(!std::strcmp(observation.update(123000,false,false,true),"unknown"));assert(!observation.usable());
  assert(!std::strcmp(observation.update(124000,true,false,false,4),"domestic_hot_water"));
  observation=HeatingObservation{};const uint32_t dhw_before=0xfffff000;
  observation.update(dhw_before,true,true,false);assert(!std::strcmp(observation.update(dhw_before+120000,true,false,false),"idle"));
  auto c=ready();assert(c.update(1000)==43.5f);
  c.remote_mode=true;assert(c.accept_remote(2000,1000,90,true,50));assert(c.update(2000)==50);
  assert(c.update(90999)==50);assert(c.update(91000)==43.5f);assert(strstr(c.mode(),"PID"));
  assert(c.accept_remote(100000,100000,90,false,0));assert(c.update(100001)==0);
  assert(!c.accept_remote(100000,100000,91,true,50));assert(!c.accept_remote(100000,100000,90,true,53));assert(!c.accept_remote(100000,100000,90,false,35));assert(!c.accept_remote(120000,100000,90,true,50));
  c.local_temperature=6;c.comfort_enabled=false;assert(c.update(100002)==40);assert(c.frost_active());c.local_temperature=8;assert(c.update(100003)==40);c.local_temperature=9;assert(c.update(100004)==0);
  c.local_temperature=6;c.local_valid=false;assert(c.update(100005)==0);assert(!c.frost_active());
  c=ready();c.fault=true;assert(c.update(2000)==0);c.fault=false;c.ot_fresh=false;assert(c.update(2001)==0);
  c=ready();c.pid_valid=false;assert(c.update(2000)==0);c.pid_valid=true;c.pid_level=NAN;assert(c.update(2001)==0);
  c=ready();c.min_off_ms=180000;assert(c.update(179999)==0);assert(c.update(180000)>0);c.pid_level=0;assert(c.update(180001)==0);c.pid_level=1;assert(c.update(200000)==0);c.local_temperature=6;assert(c.update(200001)==40);
  c=ready();c.remote_mode=true;const uint32_t before=0xfffff000;assert(c.accept_remote(before,before,90,true,45));assert(c.update(before+60000)==45);assert(c.update(before+90000)==43.5f);
  c=ready();assert(!c.accept_remote(1000,1000,90,true,50));assert(c.update(1000)==43.5f);
  std::cout<<"Controller tests passed: bounded capture/expiry/acknowledgements, runtime settings, DHW phases, PID, leases, frost, faults, sensor loss, anti-cycling and rollover.\n";
}
