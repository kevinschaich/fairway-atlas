import test from 'node:test';import assert from 'node:assert/strict';const {clubBackswing,clubReleaseMs,clubSwingAt}=await import('../src/game/club-animation.js');
test('release joins the raised backswing continuously at all powers and reaches a higher finish sooner',()=>{
 for(const putter of [false,true])for(const power of [.05,.25,.5,.65,1]){const back=clubBackswing(power,putter),release=clubReleaseMs(putter);assert.equal(clubSwingAt(-release/1000,back,release,putter),-back);assert.equal(clubSwingAt(0,back,release,putter),0);let previous=-back;for(let t=-release/1000;t<.4;t+=.005){const angle=clubSwingAt(t,back,release,putter);assert.ok(angle>=previous-1e-10);previous=angle;}}
 assert.ok(clubBackswing(.5)>1.3&&clubBackswing(.5)<1.45);assert.equal(clubBackswing(1),2.75);assert.ok(clubBackswing(.1)<clubBackswing(.2)-clubBackswing(.1));assert.equal(clubSwingAt(.22,2.25,190),2.45);assert.ok(clubReleaseMs()<320);
});
