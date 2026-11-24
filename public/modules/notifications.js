import {api,esc,pill,input,fields,toast} from '../ui.js';

export function notificationContent(config,discovery) {
  const budget={enabled:false,thresholdPercent:90,targets:[],pauseAction:true,...config.gasBudget};
  const devices=[...discovery.targets];
  for(const id of config.targets)if(!devices.some(device=>device.id===id))devices.push({id,name:'Saved notification device',address:id.replace(/^(entity|service):/,''),available:false,kind:'Saved recipient'});
  const available=discovery.targets.filter(device=>device.available);
  const preferred=available.find(device=>config.targets.includes(device.id))?.id || available[0]?.id || '';
  const phones=discovery.targets.filter(device=>device.id.startsWith('service:notify.mobile_app_'));
  for(const id of budget.targets)if(!phones.some(device=>device.id===id))phones.push({id,name:'Saved phone',address:id.replace(/^service:/,''),available:false});
  return `<div class="settings-grid notification-grid"><section class="card settings-card"><div class="settings-heading"><h2>Notification devices</h2>${pill(discovery.error?'Awaiting connection':`${available.length} available`,discovery.error?'amber':available.length?'green':'neutral')}</div>
    ${discovery.error?`<p class="inline-note" role="status">${esc(discovery.error)} <a class="text-link" href="#settings/connections">Open Connections →</a></p>`:''}
    ${!discovery.error&&!discovery.targets.length?'<p class="inline-note">Enable notifications in the Home Assistant Companion app or add a notify entity, then refresh devices.</p>':''}
    <form id="notification-settings-form"><label class="notification-toggle"><input type="checkbox" name="enabled" ${config.enabled?'checked':''}>Enable notifications</label>
    <fieldset class="notification-devices"><legend>Recipients</legend>${devices.length?devices.map(device=>`<label class="notification-device"><input type="checkbox" name="targets" value="${esc(device.id)}" ${config.targets.includes(device.id)?'checked':''} ${!device.available&&!config.targets.includes(device.id)?'disabled':''}><span><strong>${esc(device.name)}</strong><small>${esc(device.address)} · ${esc(device.kind)}${device.available?'':' · unavailable'}</small></span></label>`).join(''):'<p class="field-help">Your notification devices will appear here.</p>'}</fieldset>
    <fieldset class="notification-devices"><legend>Gas budget warnings</legend>
    <label class="notification-toggle"><input type="checkbox" name="budgetEnabled" ${budget.enabled?'checked':''}>Warn when approaching the daily gas budget</label>
    ${input('Warn at % of daily budget used','budgetThreshold',budget.thresholdPercent,'type="number" min="1" max="100" step="1" required')}
    ${phones.length?phones.map(device=>`<label class="notification-device"><input type="checkbox" name="budgetTargets" value="${esc(device.id)}" ${budget.targets.includes(device.id)?'checked':''} ${!device.available&&!budget.targets.includes(device.id)?'disabled':''}><span><strong>${esc(device.name)}</strong><small>${esc(device.address)}${device.available?'':' · unavailable'}</small></span></label>`).join(''):'<p class="field-help">Refresh devices after connecting the Home Assistant Companion app on your phone.</p>'}
    <label class="notification-toggle"><input type="checkbox" name="budgetPauseAction" ${budget.pauseAction?'checked':''}>Include a “Pause heating today” button</label>
    <p class="field-help">Enable the gas budget to send one warning per day to each selected phone.</p>
    <p class="field-help">Expand the phone notification to pause Active heating until midnight. Resume from the gas budget page.</p>
    ${budget.enabled&&budget.pauseAction?`<p class="inline-note" role="status">${discovery.actions?.ready?'Phone action connection ready.':esc(discovery.actions?.error || 'Waiting for Home Assistant event access for phone buttons.')}</p>`:''}
    </fieldset>
    <div class="form-actions compact"><button class="button secondary" type="submit">Save notifications</button><button class="button secondary" type="button" id="refresh-notification-devices">Refresh devices</button></div><p class="form-error" role="alert"></p><p class="notification-result" role="status" aria-live="polite"></p></form></section>
    <section class="card settings-card"><div class="settings-heading"><h2>Send a test notification</h2></div>
    <form id="notification-test-form"><label>Test device<select name="target" aria-label="Test device" required ${available.length?'':'disabled'}><option value="">Choose a device…</option>${discovery.targets.map(device=>`<option value="${esc(device.id)}" ${device.id===preferred?'selected':''} ${device.available?'':'disabled'}>${esc(device.name)} · ${esc(device.address)}${device.available?'':' · unavailable'}</option>`).join('')}</select></label>
    ${input('Title','title','Cold Harbour','maxlength="120"')}
    <label>Message<textarea name="message" rows="4" maxlength="2000" required>This is a test notification from Cold Harbour.</textarea></label>
    <p class="field-help">Confirm delivery on the selected device.</p>
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
        const data=new FormData(settings),values={enabled:settings.elements.enabled.checked,targets:data.getAll('targets'),gasBudget:{enabled:settings.elements.budgetEnabled.checked,thresholdPercent:Number(settings.elements.budgetThreshold.value),targets:data.getAll('budgetTargets'),pauseAction:settings.elements.budgetPauseAction.checked}};
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
