var obj = {};
obj.value = 55;
var tmp = obj.value;

var out = {};
out.result = tmp;

var data = {};
data.id = 1;

function process() {
  var data = {};
  data.id = "abc";
  data.active = true;
}

data.active = "false";
//TODO: solver failed for obj
