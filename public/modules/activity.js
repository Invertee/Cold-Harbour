import {dateTime, api,esc,icon,empty } from '../ui.js';
export const activity={
  id:'activity',label:'Activity log',icon:'activity',
  async render(ctx){const events=await api('events');return `<section class="card activity-log">${events.length?events.map(event=>`<div class="log-item"><span class="tile-icon">${icon(event.kind==='heating'?'heating':'connections')}</span><div><strong>${esc(event.message)}</strong><p>${dateTime(event.at,ctx.config.general.timezone,{day:'numeric',month:'short',second:'2-digit'})}</p></div><span class="small-tag">${esc(event.kind)}</span></div>`).join(''):empty('No activity recorded','Settings changes and thermostat commands will appear here.')}</section>`;},
};
