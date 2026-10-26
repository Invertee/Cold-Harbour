import {api,esc,icon,empty,toast} from '../ui.js';

export const defaultEntityView={query:'',type:'',availability:'',sort:'name',direction:'asc',page:1,pageSize:25};
const collator=new Intl.Collator('en-GB',{numeric:true,sensitivity:'base'});
const name=entity=>entity.attributes?.friendly_name || entity.entity_id;
const type=entity=>entity.entity_id.split('.')[0];
const available=entity=>!['unknown','unavailable'].includes(String(entity.state).toLowerCase());
export function entityPage(entities,view){
  const terms=view.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const filtered=entities.filter(entity=>{
    const text=`${name(entity)} ${entity.entity_id} ${entity.state} ${entity.attributes?.unit_of_measurement || ''}`.toLowerCase();
    return terms.every(term=>text.includes(term))&&(!view.type||type(entity)===view.type)&&(!view.availability||available(entity)===(view.availability==='available'));
  });
  const value=entity=>({name:name(entity),id:entity.entity_id,state:entity.state,type:type(entity)})[view.sort];
  filtered.sort((a,b)=>{
    const av=value(a),bv=value(b),numeric=view.sort==='state'&&String(av).trim()!==''&&String(bv).trim()!==''&&Number.isFinite(Number(av))&&Number.isFinite(Number(bv));
    const order=numeric?Number(av)-Number(bv):collator.compare(String(av),String(bv));
    return (order||collator.compare(a.entity_id,b.entity_id))*(view.direction==='desc'?-1:1);
  });
  const pages=Math.max(1,Math.ceil(filtered.length/view.pageSize)),page=Math.max(1,Math.min(view.page,pages)),start=(page-1)*view.pageSize;
  return {items:filtered.slice(start,start+view.pageSize),total:filtered.length,page,pages,start:filtered.length?start+1:0,end:Math.min(start+view.pageSize,filtered.length)};
}
const options=(items,value)=>items.map(([id,label])=>`<option value="${esc(id)}" ${id===value?'selected':''}>${esc(label)}</option>`).join('');
function usage(entity){
  if(type(entity)==='climate')return '<a class="text-link" href="#heating">Assign valve / temperature →</a>';
  if(['°C','°F'].includes(entity.attributes?.unit_of_measurement))return '<a class="text-link" href="#heating">Map to a room →</a>';
  if(['W','kW'].includes(entity.attributes?.unit_of_measurement))return '<a class="text-link" href="#settings/connections">Use for live power →</a>';
  return '<span class="muted">—</span>';
}
export const entities={
  id:'entities',label:'Entity library',icon:'entities',view:{...defaultEntityView},items:[],
  async render(){
    const {entities,status}=await api('entities');this.items=entities;
    const types=[...new Set(entities.map(type))].sort((a,b)=>collator.compare(a,b));
    if(this.view.type&&!types.includes(this.view.type)){this.view.type='';this.view.page=1;}
    return `<section class="card entity-card"><div class="section-heading"><div><h2>Entity library</h2><p>Find Home Assistant entities to use in your connections and rooms.</p></div><button class="button secondary" id="reload-entities" type="button">${icon('refresh')}Load entities</button></div>
      ${!status.connected?`<p class="inline-note">${esc(status.error || 'Home Assistant is not connected. Load entities after saving your connection.')}</p>`:''}
      <div class="entity-filters"><div class="entity-search-label"><label for="entity-search">Search</label><div class="search-field">${icon('search')}<input type="search" id="entity-search" placeholder="Name, ID, state or unit…" value="${esc(this.view.query)}"></div></div>
      <label>Type<select id="entity-type">${options([['','All types'],...types.map(t=>[t,t])],this.view.type)}</select></label>
      <label>Availability<select id="entity-availability">${options([['','All entities'],['available','Available'],['unavailable','Unknown / unavailable']],this.view.availability)}</select></label>
      <button class="button secondary" type="button" id="clear-entity-filters">Clear filters</button></div>
      ${entities.length?'<div id="entity-results"></div>':empty('No Home Assistant entities','Connect Home Assistant to load sensors and devices.','<a href="#settings/connections" class="button">Connect Home Assistant</a>')}</section>`;
  },
  draw(){
    const target=document.querySelector('#entity-results');if(!target)return;
    const result=entityPage(this.items,this.view);this.view.page=result.page;
    const heading=(key,label)=>`<th scope="col" aria-sort="${this.view.sort===key?(this.view.direction==='asc'?'ascending':'descending'):'none'}"><button type="button" data-entity-sort="${key}" aria-label="Sort by ${label}${this.view.sort===key?`, currently ${this.view.direction==='asc'?'ascending':'descending'}`:''}">${label}<span aria-hidden="true">${this.view.sort===key?(this.view.direction==='asc'?'↑':'↓'):'↕'}</span></button></th>`;
    target.innerHTML=`<p class="entity-count" role="status">${result.start}–${result.end} of ${result.total} matching entities · ${this.items.length} total</p>
      <div class="table-scroll entity-table-scroll" tabindex="0" role="region" aria-label="Entity library results"><table class="entity-table"><caption class="sr-only">Home Assistant entities. Select a column heading to sort.</caption><thead><tr>${heading('name','Entity')}${heading('id','Entity ID')}${heading('state','State')}${heading('type','Type')}<th scope="col">Use in Cold Harbour</th></tr></thead><tbody>${result.items.map(entity=>`<tr><td><strong>${esc(name(entity))}</strong></td><td class="entity-id">${esc(entity.entity_id)}</td><td><span class="entity-value ${available(entity)?'':'muted'}">${esc(entity.state)} <small>${esc(entity.attributes?.unit_of_measurement || '')}</small></span></td><td><span class="small-tag">${esc(type(entity))}</span></td><td>${usage(entity)}</td></tr>`).join('')}</tbody></table></div>
      ${result.total?'':'<p class="no-results">No entities match these filters. Try a different search or clear filters.</p>'}
      <div class="entity-pagination"><label>Rows per page<select id="entity-page-size">${options([25,50,100].map(n=>[String(n),String(n)]),String(this.view.pageSize))}</select></label><span>Page ${result.page} of ${result.pages}</span><div><button class="button secondary" id="entity-previous" type="button" ${result.page===1?'disabled':''}>Previous</button><button class="button secondary" id="entity-next" type="button" ${result.page===result.pages?'disabled':''}>Next</button></div></div>`;
    for(const button of target.querySelectorAll('[data-entity-sort]'))button.onclick=()=>{
      const sort=button.dataset.entitySort;this.view.direction=this.view.sort===sort&&this.view.direction==='asc'?'desc':'asc';this.view.sort=sort;this.view.page=1;this.draw();document.querySelector(`[data-entity-sort="${sort}"]`).focus();
    };
    document.querySelector('#entity-page-size').onchange=event=>{this.view.pageSize=Number(event.target.value);this.view.page=1;this.draw();document.querySelector('#entity-page-size').focus();};
    for(const [id,delta] of [['entity-previous',-1],['entity-next',1]])document.getElementById(id).onclick=()=>{this.view.page+=delta;this.draw();document.getElementById(id).focus();};
  },
  bind(ctx){
    this.draw();
    for(const [id,key,event] of [['entity-search','query','oninput'],['entity-type','type','onchange'],['entity-availability','availability','onchange']])document.getElementById(id)[event]=event=>{this.view[key]=event.target.value;this.view.page=1;this.draw();};
    document.querySelector('#clear-entity-filters').onclick=()=>{for(const [id,key] of [['entity-search','query'],['entity-type','type'],['entity-availability','availability']]){this.view[key]='';document.getElementById(id).value='';}this.view.page=1;this.draw();document.querySelector('#entity-search').focus();};
    document.querySelector('#reload-entities').onclick=async event=>{
      const button=event.currentTarget;button.disabled=true;
      try{await api('refresh',{method:'POST',body:'{}'});await ctx.reload();}catch(error){toast(error.message,true);}finally{button.disabled=false;}
    };
  },
};
