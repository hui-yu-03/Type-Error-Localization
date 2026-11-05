const obj = { a: 1, b: "hello" };
const keys = Object.keys(obj);
const vals = Object.values(obj);
const merged = Object.assign({}, obj);
const frozen = Object.freeze(obj);
const has = Object.hasOwn(obj, "a");
const names = Object.getOwnPropertyNames(obj);
