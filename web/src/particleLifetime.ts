// Lifetime/color subset only. Particle birth parameters must come from the caller;
// this deliberately does not substitute a browser PRNG for Unity's seeded RNG.
export type ParticleLifetime = {
  initialColor: {r:number;g:number;b:number;a:number}
  alphaKeys:number[][]
  colorKeys:number[][]
  removeAt:number
}
function gradient(keys:number[][], time:number, channel:number) {
  if (!keys.length) throw Error('Empty particle gradient')
  if (time <= keys[0][0]) return keys[0][channel]
  for (let i=1;i<keys.length;i++) {
    const b=keys[i],a=keys[i-1]
    if(time<=b[0]) return a[channel]+(b[channel]-a[channel])*(time-a[0])/(b[0]-a[0])
  }
  return keys[keys.length-1][channel]
}
export function sampleParticleLifetime(spec:ParticleLifetime, elapsed:number, lifetime:number) {
  if(!Number.isFinite(elapsed)||!Number.isFinite(lifetime)||lifetime<=0) throw Error('Invalid particle time')
  const visible=elapsed>=0&&elapsed<lifetime&&elapsed<spec.removeAt
  const t=Math.max(0,Math.min(1,elapsed/lifetime)),c=spec.initialColor
  return {visible,color:[c.r*gradient(spec.colorKeys,t,1),c.g*gradient(spec.colorKeys,t,2),
    c.b*gradient(spec.colorKeys,t,3),visible?c.a*gradient(spec.alphaKeys,t,1):0]}
}
