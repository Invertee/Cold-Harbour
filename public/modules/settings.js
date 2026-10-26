import {connections} from './connections.js';
import {entities} from './entities.js';
import {backups} from './backups.js';
import {notifications} from './notifications.js';

const sections=[connections,notifications,entities,backups];
export const settings={
  id:'settings',label:'Settings',icon:'settings',
  section(){return sections.find(section=>section.id===location.hash.split('/')[1]) || connections;},
  async render(ctx){
    const section=this.section();
    return `<div class="settings-intro"><h2>Settings</h2><p class="muted">Manage connections and notifications, browse entities and move configuration between instances.</p></div>
      <div class="settings-tabs" aria-label="Settings sections">${sections.map(item=>`<a href="#settings/${item.id}" ${item===section?'class="selected" aria-current="page"':''}>${item.label}</a>`).join('')}</div>
      ${await section.render(ctx)}`;
  },
  bind(ctx){this.section().bind(ctx);},
};
