#pragma once
#include <cstdint>
#include <cstring>
#include <string>

namespace esphome::cold_harbour {
struct StoredConnection {
  uint32_t magic{0x43483031};
  char url[231]{};
  char key[65]{};
};

// Independent of ESPHome so validation, restoration and generations can be tested.
class ConnectionSettings {
 public:
  static bool normalize_url(const std::string &value,std::string &out){
    if(value.empty()){out.clear();return true;}
    if(value.size()>230)return false;
    const size_t start=value.compare(0,7,"http://")==0?7:value.compare(0,8,"https://")==0?8:0;
    if(!start)return false;
    std::string base=value;
    if(base.back()=='/')base.pop_back();
    if(base.size()<=start)return false;
    const std::string authority=base.substr(start);
    for(unsigned char c:authority)if(c<=32 || c>=127 || c=='/' || c=='\\' || c=='?' || c=='#' || c=='@')return false;
    std::string host,port;
    if(authority.front()=='['){
      const size_t end=authority.find(']');
      if(end==std::string::npos || end<=1)return false;
      host=authority.substr(1,end-1);
      if(host.find(':')==std::string::npos)return false;
      for(char c:host)if(!((c>='0'&&c<='9')||(c>='a'&&c<='f')||(c>='A'&&c<='F')||c==':'||c=='.'))return false;
      if(end+1<authority.size()){if(authority[end+1]!=':')return false;port=authority.substr(end+2);if(port.empty())return false;}
    }else{
      const size_t colon=authority.find(':');
      host=authority.substr(0,colon);
      if(host.empty())return false;
      for(char c:host)if(!((c>='a'&&c<='z')||(c>='A'&&c<='Z')||(c>='0'&&c<='9')||c=='-'||c=='_'||c=='.'))return false;
      if(colon!=std::string::npos){port=authority.substr(colon+1);if(port.empty())return false;}
    }
    if(!port.empty()){
      if(port.size()>5)return false;
      unsigned number=0;for(char c:port){if(c<'0'||c>'9')return false;number=number*10+unsigned(c-'0');}
      if(number==0 || number>65535)return false;
    }
    out=base;return true;
  }
  static bool valid_key(const std::string &key){
    if(key.empty())return true;
    if(key.size()!=64)return false;
    for(char c:key)if(!((c>='0'&&c<='9')||(c>='a'&&c<='f')))return false;
    return true;
  }
  bool set_url(const std::string &value){std::string normalized;if(!normalize_url(value,normalized))return false;if(url_!=normalized){url_=normalized;++generation_;}return true;}
  bool set_key(const std::string &value){if(!valid_key(value))return false;if(key_!=value){key_=value;++generation_;}return true;}
  bool ready() const{return !url_.empty()&&!key_.empty();}
  const std::string &url() const{return url_;}
  const std::string &key() const{return key_;}
  uint32_t generation() const{return generation_;}
  bool accepts_generation(uint32_t generation) const{return generation==generation_;}
  StoredConnection stored() const{StoredConnection result;std::memcpy(result.url,url_.c_str(),url_.size()+1);std::memcpy(result.key,key_.c_str(),key_.size()+1);return result;}
  bool restore(const StoredConnection &saved){
    if(saved.magic!=0x43483031 || saved.url[230]!=0 || saved.key[64]!=0)return false;
    ConnectionSettings next=*this;
    if(!next.set_url(saved.url)||!next.set_key(saved.key))return false;
    *this=next;return true;
  }
 private:
  std::string url_,key_;
  uint32_t generation_{0};
};
}
