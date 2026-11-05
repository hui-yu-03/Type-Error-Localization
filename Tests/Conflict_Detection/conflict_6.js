// stats__global <= {value: T_num} and stats__global <= {value: T_str} -> conflict

var stats = {};
stats.value = 100;

function corrupt() {
  stats.value = "broken";
}

var safe = stats.value + 1;
