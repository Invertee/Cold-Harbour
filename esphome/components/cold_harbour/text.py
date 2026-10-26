import esphome.codegen as cg
import esphome.config_validation as cv
from esphome.components import text
from . import ColdHarbour, ns

DEPENDENCIES = ["cold_harbour"]
ServerURLText = ns.class_("ServerURLText", text.Text)
PairingKeyText = ns.class_("PairingKeyText", text.Text)

CONFIG_SCHEMA = cv.Schema({
    cv.Required("cold_harbour_id"): cv.use_id(ColdHarbour),
    cv.Optional("server_url"): text.text_schema(ServerURLText,mode="TEXT",entity_category="config"),
    cv.Optional("pairing_key"): text.text_schema(PairingKeyText,mode="PASSWORD",entity_category="config"),
})

async def to_code(config):
    parent = await cg.get_variable(config["cold_harbour_id"])
    for name,maximum in (("server_url",230),("pairing_key",64)):
        if name in config:
            var = await text.new_text(config[name],min_length=0,max_length=maximum)
            cg.add(var.set_parent(parent))
            cg.add(getattr(parent,"set_" + name + "_text")(var))
