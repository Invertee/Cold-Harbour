import {api,esc,pill,input,fields,toast} from '../ui.js';

export function notificationContent(config,discovery) {
  const devices=[...discovery.targets];
  for(const id of config.targets)if(!devices.some(device=>device.id===id))devices.push({id,name:'Saved notification device',address:id.replace(/^(entity|service):/,''),available:false,kind:'Saved recipient'});
  const available=discovery.targets.filter(device=>device.available);
  const preferred=available.find(device=>config.targets.includes(device.id))?.id || available[0]?.id || '';
  return `<div class="settings-grid notification-grid"><section class="card settings-card"><div class="settings-heading"><h2>Notification devices</h2>${pill(discovery.error?'Awaiting connection':`${available.length} available`,discovery.error?'amber':available.length?'green':'neutral')}</div>
    <p class="notification-description">Send Cold Harbour messages through your Home Assistant connection. Choose the devices to use when sending to saved recipients.</p>
    ${discovery.error?`<p class="inline-note" role="status">${esc(discovery.error)} <a class="text-link" href="#settings/connections">Open Connections →</a></p>`:''}
    ${!discovery.error&&!discovery.targets.length?'<p class="inline-note">No notification devices found. Sign in to the Home Assistant Companion app on your phone and allow notifications, or enable a notify entity in Home Assistant. Then refresh devices.</p>':''}
    <form id="notification-settings-form"><label class="notification-toggle"><input type="checkbox" name="enabled" ${config.enabled?'checked':''}>Enable sending to saved devices</label>
    <fieldset class="notification-devices"><legend>Recipients</legend>${devices.length?devices.map(device=>`<label class="notification-device"><input type="checkbox" name="targets" value="${esc(device.id)}" ${config.targets.includes(device.id)?'checked':''} ${!device.available&&!config.targets.includes(device.id)?'disabled':''}><span><strong>${esc(device.name)}</strong><small>${esc(device.address)} · ${esc(device.kind)}${device.available?'':' · unavailable'}</small></span></label>`).join(''):'<p class="field-help">Your notification devices will appear here.</p>'}</fieldset>
    <p class="field-help">Save your preferred recipients here. Test messages go only to the device selected alongside, even while sending to saved devices is off.</p>
    <div class="form-actions compact"><button class="button secondary" type="submit">Save notifications</button><button class="button secondary" type="button" id="refresh-notification-devices">Refresh devices</button></div><p class="form-error" role="alert"></p><p class="notification-result" role="status" aria-live="polite"></p></form></section>
    <section class="card settings-card"><div class="settings-heading"><h2>Send a test notification</h2></div><p class="notification-description">Choose one Home Assistant device and send a message to check that notifications reach it.</p>
    <form id="notification-test-form"><label>Test device<select name="target" aria-label="Test device" required ${available.length?'':'disabled'}><option value="">Choose a device…</option>${discovery.targets.map(device=>`<option value="${esc(device.id)}" ${device.id===preferred?'selected':''} ${device.available?'':'disabled'}>${esc(device.name)} · ${esc(device.address)}${device.available?'':' · unavailable'}</option>`).join('')}</select></label>
    ${input('Title','title','Cold Harbour','maxlength="120"')}
    <label>Message<textarea name="message" rows="4" maxlength="2000" required>This is a test notification from Cold Harbour.</textarea></label>
    <p class="field-help">Home Assistant must expose a notification destination for this device. A successful request means Home Assistant accepted it; confirm delivery on your device. Titles appear where supported.</p>
    <div class="form-actions compact"><button class="button" type="submit" ${available.length?'':'disabled'}>Send test message</button></div><p class="form-error" role="alert"></p><p class="notification-result" role="status" aria-live="polite"></p></form></section></div>`;
}

export const notifications={
  id:'notifications',label:'Notifications',
  async render(ctx){return notificationContent(ctx.config.notifications,await api('notifications'));},
  bind(ctx){
    const settings=document.querySelector('#notification-settings-form'),test=document.querySelector('#notification-test-form');
    settings.onsubmit=async event=>{
      event.preventDefault();const button=settings.querySelector('[type="submit"]'),error=settings.querySelector('.form-error'),result=settings.querySelector('.notification-result');
      button.disabled=true;error.textContent='';result.textContent='';
      try{
        const values={enabled:settings.elements.enabled.checked,targets:new FormData(settings).getAll('targets')};
        ctx.config=await api('settings',{method:'POST',body:JSON.stringify({section:'notifications',values})});
        result.textContent='Notification settings saved.';toast(result.textContent);
      }catch(err){error.textContent=err.message;}finally{button.disabled=false;}
    };
    document.querySelector('#refresh-notification-devices').onclick=async event=>{
      const button=event.currentTarget;button.disabled=true;
      try{await ctx.reload();}catch(err){settings.querySelector('.form-error').textContent=err.message;}finally{button.disabled=false;}
    };
    test.onsubmit=async event=>{
      event.preventDefault();const button=test.querySelector('[type="submit"]'),error=test.querySelector('.form-error'),result=test.querySelector('.notification-result');
      button.disabled=true;button.textContent='Sending…';error.textContent='';result.textContent='';
      try{
        const response=await api('notifications/test',{method:'POST',body:JSON.stringify(fields(test))});
        result.textContent=response.message;toast('Test notification accepted by Home Assistant.');
      }catch(err){error.textContent=err.message;}finally{button.disabled=false;button.textContent='Send test message';}
    };
  },
};
