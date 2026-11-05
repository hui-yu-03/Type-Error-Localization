const nums = [1, 2, 3];
var sum = 0;
nums.forEach(function(n) { sum = sum + n; });
const first = nums.find(function(n) { return n > 1; });
const fi = nums.findIndex(function(n) { return n > 1; });
const total = nums.reduce(function(acc, n) { return acc + n; }, 0);
