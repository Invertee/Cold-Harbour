"""Bounded dual-mode boiler controller. ESPHome retains the OpenTherm driver."""
import re
from urllib.parse import urlparse
import esphome.codegen as cg
import esphome.config_validation as cv
from esphome.components import esp32, output, sensor, pid, api, opentherm
from esphome.components.pid.climate import PIDClimate
from esphome.const import CONF_ID
from esphome.core import CORE

AUTO_LOAD = ["json", "network", "text"]
DEPENDENCIES = ["esp32", "opentherm", "climate", "api"]
ns = cg.esphome_ns.namespace("cold_harbour")
ColdHarbour = ns.class_("ColdHarbour", cg.PollingComponent)

def validate_config(config):
    if CORE.target_framework != "esp-idf":
        raise cv.Invalid("cold_harbour requires the ESP-IDF framework")
    if config["server_url"]:
        value = config["server_url"]
        try:
            url = urlparse(value)
            port = url.port
        except ValueError as error:
            raise cv.Invalid("Invalid base server address") from error
        if len(value)>230 or not value.startswith(("http://","https://")) or not url.hostname or url.username or url.password or url.query or url.fragment or url.path not in ("", "/") or port is not None and not 1<=port<=65535:
            raise cv.Invalid("Use the base instance address, e.g. http://192.168.1.20:8102")
    if config["shared_key"] and not re.fullmatch(r"[a-f0-9]{64}", config["shared_key"]):
        raise cv.Invalid("shared_key must be the 64-character key created by Cold Harbour")
    if config["min_flow"] > config["max_flow"]:
        raise cv.Invalid("min_flow must not exceed max_flow")
    if not re.fullmatch(r"[a-z0-9_-]{1,64}", config["device_id"]):
        raise cv.Invalid("device_id must contain lowercase letters, numbers, hyphens or underscores")
    return config

CONFIG_SCHEMA = cv.All(cv.Schema({
    cv.GenerateID(): cv.declare_id(ColdHarbour),
    cv.Required("flow_output"): cv.use_id(output.FloatOutput),
    cv.Required("pid_climate"): cv.use_id(PIDClimate),
    cv.Required("local_temperature"): cv.use_id(sensor.Sensor),
    cv.Required("ha_temperature"): cv.use_id(sensor.Sensor),
    cv.Required("boiler_temperature"): cv.use_id(sensor.Sensor),
    cv.Required("api_id"): cv.use_id(api.APIServer),
    cv.GenerateID("opentherm_id"): cv.use_id(opentherm.generate.OpenthermHub),
    cv.Optional("server_url", default=""): cv.string_strict,
    cv.Optional("shared_key", default=""): cv.string_strict,
    cv.Optional("device_id", default="boiler-controller"): cv.string_strict,
    cv.Optional("min_flow", default=35): cv.float_range(min=30,max=60),
    cv.Optional("max_flow", default=52): cv.float_range(min=30,max=65),
    cv.Optional("ha_stale_after", default="10min"): cv.positive_time_period_milliseconds,
}).extend(cv.polling_component_schema("1s")),validate_config)

async def to_code(config):
    var = cg.new_Pvariable(config[CONF_ID])
    await cg.register_component(var, config)
    for option in ("flow_output","pid_climate","local_temperature","ha_temperature","boiler_temperature","api_id","opentherm_id"):
        target = await cg.get_variable(config[option])
        cg.add(getattr(var, "set_" + option)(target))
    for option in ("server_url","shared_key","device_id","min_flow","max_flow"):
        cg.add(getattr(var, "set_" + option)(config[option]))
    cg.add(var.set_ha_stale_after(config["ha_stale_after"].total_milliseconds))
    esp32.request_http_client()
    esp32.require_certificate_bundle()
