import {WEAPONS} from './sim.js';
const IDS=new Set(['m4a1','ak47','awp','usp','knife','headshot','kill','death']);
const $=id=>document.getElementById(id);
export function weaponIcon(id,label='',className=''){
 const img=document.createElement('img');img.src=`./assets/ui-cs2/${IDS.has(id)?id:'kill'}.svg`;img.alt=label;img.className='combat-icon '+className;img.draggable=false;return img;
}
export function killFeed(event,players,selfId){
 const killer=players.find(p=>p.id===event.playerId),victim=players.find(p=>p.id===event.targetId),weapon=WEAPONS[event.weapon];
 const line=document.createElement('div');line.className='feed-line';line.classList.toggle('local',event.playerId===selfId);line.classList.toggle('local-kill',event.playerId===selfId);line.classList.toggle('local-death',event.targetId===selfId);
 const attacker=document.createElement('b'),target=document.createElement('b');attacker.textContent=killer?.name||'玩家';target.textContent=victim?.name||'玩家';attacker.classList.toggle('orange',killer?.team===1);target.classList.toggle('orange',victim?.team===1);
 line.append(attacker,weaponIcon(weapon?.id,weapon?.name||'击杀','feed-weapon'));if(event.headshot)line.append(weaponIcon('headshot','爆头','feed-headshot'));line.append(target);
 line.setAttribute('aria-label',`${attacker.textContent} 使用 ${weapon?.name||'武器'}${event.headshot?'爆头':''}击败 ${target.textContent}`);
 $('killfeed').append(line);while($('killfeed').children.length>5)$('killfeed').firstChild.remove();setTimeout(()=>line.remove(),event.playerId===selfId||event.targetId===selfId?7500:5000);
}
export function updateEquipment(player){
 const slots=[player.primaryWeapon??0,3,4];
 for(const button of $('weapon-slots').children){const slot=Number(button.dataset.equipSlot)-1,id=slots[slot],weapon=WEAPONS[id];button.classList.toggle('active',player.weapon===id);button.setAttribute('aria-pressed',String(player.weapon===id));button.querySelector('.slot-name').textContent=weapon.name;const img=button.querySelector('img');const src=`./assets/ui-cs2/${weapon.id}.svg`;if(img.getAttribute('src')!==src)img.setAttribute('src',src);img.alt=weapon.name;}
}
export function updateDeath(player,players,time){
 $('death').hidden=player.alive;document.body.classList.toggle('is-dead',!player.alive);if(player.alive)return;
 const killer=players.find(p=>p.id===player.killerId),weapon=WEAPONS[player.deathWeapon];$('death-killer').textContent=killer?.name||'对手';$('death-weapon').textContent=weapon?.name||'武器';$('death-headshot').hidden=!player.deathHeadshot;
 const img=$('death-weapon-icon'),src=`./assets/ui-cs2/${weapon?.id||'kill'}.svg`;if(img.getAttribute('src')!==src)img.src=src;img.alt=weapon?.name||'击败';$('death-timer').textContent=Math.max(0,Math.ceil(player.respawnAt-time));
}
export function scopeOverlay(level,player,paused){
 const visible=level>0&&player?.weapon===2&&player.alive&&!paused;
 $('scope').hidden=!visible;$('scope').dataset.level=String(visible?level:0);
 if(visible)$('scope').style.setProperty('--scope-radius',Math.min(innerWidth,innerHeight)*.49+'px');
}
