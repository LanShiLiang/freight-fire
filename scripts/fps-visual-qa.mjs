// Run browsers sequentially: map/passages + exhaustive native pose checks,
// first-person draw/fire/reload/light/heavy screenshots, then characters and
// corpse/death-camera integration. Each imported suite closes its own Chrome.
for(const suite of ['transport-qa.mjs','cs2-rig-qa.mjs','characters-upgrade-qa.mjs']){
 console.log('FPS visual acceptance: '+suite);
 await import('./'+suite);
}
