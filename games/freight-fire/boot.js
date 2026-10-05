import {loadingScreen} from './loading-screen.js';

// Observe entry-module errors before its large dependency tree is evaluated.
// The gameplay module reports byte progress once it starts executing.
const deadline=setTimeout(()=>{if(!loadingScreen.started)loadingScreen.fail(new Error('战场脚本超过 45 秒仍未载入'),{reload:true});},45000);
import('./game.js').catch(error=>loadingScreen.fail(error,{reload:true})).finally(()=>clearTimeout(deadline));
