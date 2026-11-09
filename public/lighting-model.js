export const defaultLighting={enabled:false,transitionSeconds:60,warmElevation:-6,coolElevation:45,groups:[]};
export const defaultLightGroup={name:'',enabled:true,minKelvin:2200,maxKelvin:6500,entities:[]};

// A fixed elevation curve keeps low winter sun warmer than high summer sun.
// Smoothstep eases the change at both ends of civil twilight / full daylight.
export function daylightProgress(elevation,warmElevation=-6,coolElevation=45){
  const fraction=Math.max(0,Math.min(1,(elevation-warmElevation)/(coolElevation-warmElevation)));
  return fraction*fraction*(3-2*fraction);
}
export function daylightKelvin(group,elevation,settings=defaultLighting){
  return Math.round(group.minKelvin+(group.maxKelvin-group.minKelvin)*daylightProgress(elevation,settings.warmElevation,settings.coolElevation));
}
export function lightCapabilities(state){
  const attributes=state?.attributes || {},min=attributes.min_color_temp_kelvin,max=attributes.max_color_temp_kelvin;
  const aggregate=Array.isArray(attributes.entity_id)&&attributes.entity_id.length>0;
  const supported=Boolean(state?.entity_id?.startsWith('light.')&&!aggregate&&attributes.supported_color_modes?.includes('color_temp')&&Number.isFinite(min)&&Number.isFinite(max)&&min>0&&min<=max);
  const kelvin=attributes.color_temp_kelvin;
  return {supported,minKelvin:Number.isFinite(min)?min:null,maxKelvin:Number.isFinite(max)?max:null,transition:Boolean(attributes.supported_features&32),currentKelvin:Number.isFinite(kelvin)&&kelvin>0?kelvin:null,
    reason:aggregate?'Choose the individual lights inside this Home Assistant group.':!supported?'This light does not report an adjustable white temperature range.':null};
}
