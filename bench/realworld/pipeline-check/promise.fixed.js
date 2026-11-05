const p = Promise.resolve(42);
const a = p.then(s => s * 2);
const b = p.then(t => t - 1);
