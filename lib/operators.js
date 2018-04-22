/**
 * Just names for operators
 *
 * @module  glsl-js/lib/operators
 */

var Descriptor = require('./descriptor');

var floatRE = /^-?[0-9]*(?:.[0-9]+)?(?:e-?[0-9]+)?$/i;

var operators = processOperation.operators = {
	'*': 'multiply',
	'+': 'add',
	'-': 'subtract',
	'/': 'divide',
	'%': 'mod',
	'<<': 'lshift',
	'>>': 'rshift',
	'==':'equal',
	'<': 'less',
	'>': 'greater',

	//https://gcc.gnu.org/onlinedocs/cpp/C_002b_002b-Named-Operators.html#C_002b_002b-Named-Operators
	'&&': 'and',
	'&=': 'and_eq',
	'&': 'bitand',
	'|': 'bitor',
	// '~': 'compl',
	// '!': 'not',
	'!=': 'not_eq',
	'||': 'or',
	'|=': 'or_eq',
	'^': 'xor',
	'^=': 'xor_eq'
};

var opsRE = /\*|\+|\-|\/|\%|\<|\=|\>|\&|\||\!|\^|\~/;


/**
 * Return rendered operation
 */
function processOperation (left, right, operator) {
	var self = this;
	var leftType = left.type;
	var rightType = right.type;
	var operatorName = operators[operator];
  switch (operator) {
    case '*':
      return Descriptor(`my_multiple( ${left}, ${right} )`,{});
    case '+':
      return Descriptor(`my_add( ${left}, ${right} )`,{});
    case '-':
      return Descriptor(`my_subtract( ${left}, ${right} )`,{});
    case '/':
      return Descriptor(`my_divide( ${left}, ${right} )`,{});
  }
  return Descriptor(`${left} ${operator} ${right}`);
}


module.exports = processOperation;
