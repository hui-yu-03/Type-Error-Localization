const n1 = 8;
const s2 = "delta";
const b3 = true;
const xs4 = [72, 49, 21];
const ws5 = ["user", "node"];
const o6 = { id: 73, name: "user", active: true };
let acc7 = 0;
const p8 = Promise.resolve(n1);
async function g9(k) {
  const w = await p8;
  return w * k;
}
const p10 = g9(n1);
function f11(item) {
  const label = item.name + "#" + item.id;
  return label;
}
const s12 = f11(o6);
async function g13(k) {
  const w = await p8;
  return w * k;
}
const p14 = g13(n1);
async function g15(k) {
  const w = await g9(k);
  return w + n1;
}
const p16 = g15(n1);
const n17 = s12.length + 5;
const n18 = n1 - n17;
o6.name = s2;
const p19 = p16.then(v => "#" + v);
const n20 = s2.length + 15;
const s21 = f11(o6);
const s22 = ws5.join(", ");
const s23 = f11(o6);
const n24 = b3 ? n1 : n20;
xs4.push(n24);
const p25 = p10.then(v => "#" + v);
const b26 = n17 > n18;
const o27 = { id: n1, name: s23, active: b3 };
const b28 = xs4.includes(n1);
const b29 = s2.startsWith("i");
const n30 = xs4.length + 28;
const p31 = Promise.resolve(n1);
async function g32(k) {
  const w = await g9(k);
  return w + n1;
}
const p33 = g32(n1);
const n34 = xs4[0] * 26;
const o35 = { id: n30, name: s2, active: b3 };
const xs36 = [n30, n24, 5];
const s37 = f11(o6);
const s38 = `${n34}`;
function f39(v) {
  return v > 36;
}
const s40 = f11(o6);
const n41 = b29 ? n30 : n30;
const b42 = f39(n34);
const n43 = o6.id + n24;
const s44 = s2.toUpperCase();
for (let i = 0; i < xs4.length; i++) {
  acc7 = acc7 + xs4[i];
}
if (b28) {
  acc7 = acc7 + n34;
} else {
  acc7 = acc7 - 66;
}
const n45 = xs4.length + 34;
const b46 = n18 > n34;
const s47 = f11(o6);
const s48 = s40.toUpperCase();
async function g49(k) {
  const w = await p10;
  return w * k;
}
const p50 = g49(n43);
const b51 = s48 === s48;
const s52 = s47.padStart(16, "0");
const f53 = (a, b) => a * b + 54;
if (b26) {
  acc7 = acc7 + n43;
} else {
  acc7 = acc7 - 59;
}
const n54 = xs4[2] * 75;
const xs55 = [n45, n20, 61];
const n56 = xs55.length + 14;
const b57 = s40 === s48;
async function g58(k) {
  const w = await p50;
  return w * k;
}
const p59 = g58(n1);
function f60(x, y) {
  const t = x * y;
  return t + 81;
}
const n61 = n24 - n41;
const n62 = s48.length + 14;
async function g63(k) {
  const w = await p33;
  return w * k;
}
const p64 = g63(n61);
o27.name = s52;
const n65 = b57 ? n56 : n41;
const n66 = s47.length + 77;
const f67 = (a, b) => a * b + 3;
const s68 = s48.toUpperCase();
const p69 = Promise.resolve(n20);
const ws70 = [s48, s40];
async function g71(k) {
  const w = await p14;
  return w * k;
}
const p72 = g71(n66);
const o73 = { id: n43, name: s68, active: b57 };
o6.id = n62 + 21;
const o74 = { id: n65, name: s68, active: b28 };
o35.id = n65 + 37;
async function g75(k) {
  const w = await p72;
  return w * k;
}
const p76 = g75(n41);
const s77 = `${n62}`;
const n78 = Math.max(n66, n56);
o6.id = n41 + 18;
const s79 = f11(o73);
o27.id = n65 + 93;
const n80 = Math.max(n66, n65);
o73.name = s68;
const o81 = { id: n65, name: s68, active: b42 };
xs4.push(n66);
const n82 = n65 - n80;
const s83 = `${n78}`;
const s84 = `${n78}`;
const n85 = xs4.length + 46;
const s86 = f11(o6);
const n87 = xs55.length + 38;
async function g88(k) {
  const w = await g58(k);
  return w + n82;
}
const p89 = g88(n66);
xs55.push(n87);
const n90 = b57 ? n87 : n80;
for (let i = 0; i < xs4.length; i++) {
  acc7 = acc7 + xs4[i];
}
const ws91 = [s86, s86];
for (let i = 0; i < xs55.length; i++) {
  acc7 = acc7 + xs55[i];
}
const n92 = s68.length + 36;
const s93 = s83.toUpperCase();
const p94 = Promise.resolve(n85);
const o95 = { id: n92, name: s93, active: b51 };
const s96 = s84 + "-" + n66;
const n97 = n85 * 90 + n87;
const f98 = (a, b) => a * b + 49;
const ws99 = s79.split(",");
const b100 = s96 === s86;
async function g101(k) {
  const w = await p94;
  return w * k;
}
const p102 = g101(n85);
function f103(text, k) {
  const head = text.toUpperCase();
  return head.padStart(k, "*");
}
const o104 = { id: n92, name: s77, active: b46 };
function f105(x, y) {
  const t = x * y;
  return t + 16;
}
const s106 = `${s86}:${n97}`;
const s107 = `${n82}`;
const n108 = xs4.length + 3;
const n109 = b57 ? n90 : n97;
o6.name = s93;
const s110 = o35.name + s86;
function f111(v) {
  return v > 16;
}
const p112 = p94.then(v => v * 68);
async function g113(k) {
  const w = await g63(k);
  return w + n108;
}
const p114 = g113(n85);
const p115 = Promise.resolve(n97);
const s116 = o104.name + s110;
const s117 = o74.name + s52;
const ws118 = [s117, s110];
