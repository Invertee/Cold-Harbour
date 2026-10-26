import {api,esc,input,fields,toast,dateTime} from '../ui.js';

const maxBytes=8*1024*1024;
export const backups={
  id:'backups',label:'Backups',
  async render(){
    return `<div class="settings-grid backup-grid"><section class="card settings-card"><div class="settings-heading"><h2>Export configuration</h2></div>
      <p class="backup-description">Download a password-protected backup to restore this setup or move it to another Cold Harbour instance.</p>
      <p class="field-help">Includes connection settings, saved Home Assistant token, ESP pairing key, energy mappings, rooms, presence settings and heating schedules. History, activity logs and cached entities stay on this instance. Supervisor credentials and host environment settings are supplied by the destination.</p>
      <form id="backup-export-form">${input('Backup password','password','','type="password" minlength="10" maxlength="1024" required autocomplete="new-password"')}${input('Confirm password','confirmation','','type="password" minlength="10" maxlength="1024" required autocomplete="new-password"')}<p class="field-help">Use at least 10 characters. Keep the password somewhere safe; it is needed to open the backup.</p><button class="button" type="submit">Download backup</button><p class="form-error" role="alert"></p></form></section>
      <section class="card settings-card"><div class="settings-heading"><h2>Import configuration</h2></div>
      <p class="backup-description">Choose a Cold Harbour backup and review its contents before replacing this instance’s configuration.</p>
      <p class="field-help">Import replaces settings, credentials, rooms and schedules. Existing history stays here. Smart Thermostat returns to Planning and legacy radiator overrides are cleared. The next signed ESP exchange releases the boiler to Local PID; radiator settings remain as last applied.</p>
      <form id="backup-import-form"><label>Backup file<input type="file" name="file" accept=".json,application/json" required></label>${input('Backup password','password','','type="password" minlength="10" maxlength="1024" required autocomplete="off"')}<button class="button secondary" type="submit">Preview backup</button><p class="form-error" role="alert"></p></form>
      <div id="backup-preview" aria-live="polite"></div></section></div>`;
  },
  bind(ctx){
    const exportForm=document.querySelector('#backup-export-form'),importForm=document.querySelector('#backup-import-form'),preview=document.querySelector('#backup-preview');
    let pending=null;
    const clearPreview=()=>{pending=null;preview.innerHTML='';};
    importForm.oninput=clearPreview;importForm.onchange=clearPreview;
    exportForm.onsubmit=async event=>{
      event.preventDefault();const button=exportForm.querySelector('button'),error=exportForm.querySelector('.form-error'),values=fields(exportForm);error.textContent='';
      if(values.password!==values.confirmation){error.textContent='The passwords do not match.';return;}
      button.disabled=true;
      try{
        const backup=await api('backups/export',{method:'POST',body:JSON.stringify({password:values.password})});
        const url=URL.createObjectURL(new Blob([JSON.stringify(backup)],{type:'application/json'})),link=document.createElement('a');
        link.href=url;link.download=`cold-harbour-backup-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
        exportForm.reset();toast('Backup downloaded. Keep the password with your recovery information.');
      }catch(err){error.textContent=err.message;}finally{button.disabled=false;}
    };
    importForm.onsubmit=async event=>{
      event.preventDefault();clearPreview();const button=importForm.querySelector('button'),error=importForm.querySelector('.form-error');error.textContent='';button.disabled=true;
      // Freeze the file and password while checking them, so the preview always matches.
      const file=importForm.elements.file.files[0],password=importForm.elements.password.value;
      for(const input of importForm.querySelectorAll('input'))input.disabled=true;
      try{
        if(!file||file.size>maxBytes)throw new Error('Choose a backup file no larger than 8 MB.');
        let backup;try{backup=JSON.parse(await file.text());}catch{throw new Error('This file is not valid backup JSON.');}
        const data=await api('backups/preview',{method:'POST',body:JSON.stringify({backup,password})});
        pending={backup,password,previewId:data.previewId};
        preview.innerHTML=`<div class="backup-review"><h3>Review backup</h3><p>Cold Harbour ${esc(data.appVersion)} · exported ${esc(dateTime(data.exportedAt,ctx.config.general.timezone,{day:'numeric',month:'short',year:'numeric'}))}</p>
          <dl><dt>Rooms</dt><dd>${data.rooms}</dd><dt>Schedule periods</dt><dd>${data.periods}</dd><dt>Legacy schedules</dt><dd>${data.rules}</dd><dt>Timezone</dt><dd>${esc(data.timezone)}</dd><dt>Home Assistant</dt><dd>${esc(data.homeAssistantUrl || 'No saved address')}${data.supervisor?' · destination uses Supervisor':''}</dd><dt>Controller ID</dt><dd>${esc(data.controllerId)}</dd><dt>Saved HA token</dt><dd>${data.credentials.haToken?'Included':'None'}</dd><dt>ESP pairing key</dt><dd>${data.credentials.boilerKey?'Included':'None'}</dd><dt>Heating after import</dt><dd>Planning</dd></dl>
          <p class="inline-note">Review the imported connections and room mappings before selecting Active. Update the ESP’s Cold Harbour Server URL when moving to a new host.</p>
          <label class="backup-confirm"><input type="checkbox" id="confirm-backup-import">Replace this instance’s configuration with this backup.</label><div class="form-actions compact"><button class="button danger" type="button" id="apply-backup" disabled>Import configuration</button><button class="button secondary" type="button" id="cancel-backup">Cancel</button></div><p class="form-error" role="alert"></p></div>`;
        document.querySelector('#confirm-backup-import').onchange=event=>{document.querySelector('#apply-backup').disabled=!event.target.checked;};
        document.querySelector('#cancel-backup').onclick=clearPreview;
        document.querySelector('#apply-backup').onclick=async event=>{
          const action=event.currentTarget,reviewError=preview.querySelector('.form-error');reviewError.textContent='';
          if(!pending||!document.querySelector('#confirm-backup-import').checked)return;
          action.disabled=true;document.querySelector('#cancel-backup').disabled=true;document.querySelector('#confirm-backup-import').disabled=true;
          for(const input of importForm.querySelectorAll('input,button'))input.disabled=true;
          try{await api('backups/import',{method:'POST',body:JSON.stringify({...pending,confirm:true})});pending=null;await ctx.reload();toast('Configuration imported. Review connections and mappings before enabling Active.');}
          catch(err){reviewError.textContent=err.message;action.disabled=false;document.querySelector('#cancel-backup').disabled=false;document.querySelector('#confirm-backup-import').disabled=false;for(const input of importForm.querySelectorAll('input,button'))input.disabled=false;}
        };
      }catch(err){error.textContent=err.message;}finally{button.disabled=false;for(const input of importForm.querySelectorAll('input'))input.disabled=false;}
    };
  },
};
