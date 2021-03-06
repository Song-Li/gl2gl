/**
 * Transform glsl to js.
 *
 * Dev notes.
 * glsl-parser often creates identifiers/other nodes by inheriting them from definition.
 * So by writing som additional info into nodes, note that it will be accessible everywhere below, where initial id is referred by.
 *
 * @module  glsl-js/lib/index
 */

var Emitter = require('events');
var inherits = require('inherits');
var assert = require('assert');
var parse = require('./parse');
var extend = require('xtend/mutable');
var builtins = require('./builtins');
var operators = require('./operators');
var stdlib = require('./stdlib');
var flatten = require('array-flatten');
var Descriptor = require('./descriptor');
var prepr = require('prepr');
var varchanges = require('./varchanges.js')
var callchanges = require('./callchanges.js')

var floatRE = /^-?[0-9]*(?:.[0-9]+)?(?:e-?[0-9]+)?$/i;


/**
 * Create GLSL codegen instance
 *
 * @constructor
 */
function GLSL (options) {
  if (!(this instanceof GLSL)) return new GLSL(options);

  extend(this, options);

  this.reset();

  //return function compiler for convenience
  var compile = this.compile.bind(this);
  compile.compiler = this;
  compile.compile = compile;

  return compile;
};

inherits(GLSL, Emitter);


/**
 * Basic rendering settings
 */
GLSL.prototype.optimize = true;
GLSL.prototype.preprocess = prepr;
GLSL.prototype.debug = false;


/**
 * Operator names
 */
GLSL.prototype.operators = operators.operators;


/**
 * Map of builtins with their types
 */
GLSL.prototype.builtins = builtins;


/**
 * Parse string arg, return ast.
 */
GLSL.prototype.parse = parse;


/**
 * Stdlib functions
 */
GLSL.prototype.stdlib = stdlib;

/**
 * changes of names
 */
GLSL.prototype.varchanges = varchanges;
GLSL.prototype.callchanges = callchanges;



/**
 * Initialize analysing scopes/vars/types
 */
GLSL.prototype.reset = function () {
  if (this.descriptors) this.descriptors.clear();

  //cache of descriptors associated with nodes
  else this.descriptors = new Map();

  //scopes analysed. Each scope is named after the function they are contained in
  this.scopes = {
    global: {
      __name: 'global',
      __parentScope: null
    }
  };

  //hash of registered structures
  this.structs = {

  };

  //collected uniforms
  this.uniforms = {

  };

  //collected varying-s
  this.varyings = {

  };

  //collected attributes
  this.attributes = {

  };

  //collected functions, with output types
  this.functions = {

  };

  //collected stdlib functions need to be included
  this.includes = {

  };

  //current scope of the node processed
  this.currentScope = 'global';
};


/**
 * Compile whether string or tree to js
 */
GLSL.prototype.compile = function compile (arg) {
  //apply preprocessor
  if (this.preprocess) {
    if (this.preprocess instanceof Function) {
      arg = this.preprocess(arg);
    }
    else {
      arg = prepr(arg);
    }
  }

  arg = this.parse(arg);

  var result = this.process(arg);

  result = this.stringifyStdlib(this.includes) + '\n' + result;

  return result;
};


/**
 * Process glsl AST node so that it returns descriptor for a node
 * which by default casts to a string
 * but contains additional info:
 * `component` values, if node operates on array
 * `type` which is returned from the node
 * `complexity` of the node
 */
GLSL.prototype.process = function (node, arg) {
  //we don’t process descriptors

  if (node instanceof String) {
    return node;
  }

  //return cached descriptor, if already was processed
  if (this.descriptors.has(node)) {
    return this.descriptors.get(node);
  }

  //cache simple things as easy descriptors
  if (node == null ||
      typeof node === 'number' ||
      typeof node === 'string' ||
      typeof node === 'boolean') {
    return this.cache(node, Descriptor(node, {complexity: 0}));
  }


  //in some cases glsl-parser returns node object inherited from other node
  //which properties exist only in prototype.
  //Insofar structures take it’s definition type, so should be ignored.
  //See #Structures test for example.
  if (!node.hasOwnProperty('type')) return this.cache(node, Descriptor(null));

  var t = this.transforms[node.type];

  var startCall = false;

  //wrap unknown node
  if (t === undefined) {
    console.warn(`Unknown node type '${node.type}'`);
    return this.cache(node, null);
  }

  if (!t) {
    return this.cache(node, null);
  }

  if (typeof t !== 'function') {
    return this.cache(node, t);
  }

  //do start routines on the first call
  if (!this.started) {
    this.emit('start', node);
    this.started = true;
    startCall = true;
  }

  //apply node serialization
  //console.log(node.type, node.token.data);
  var result = t.call(this, node, arg);

  if (this.optimize) {
    result = this.optimizeDescriptor(result);
  }

  this.cache(result);

  this.addInclude(result.include);


  //invoke end
  if (startCall) {
    this.started = false;
    this.emit('end', node);
  }

  return result;
}


/**
 * Try to optimize descriptor -
 * whether expanding components is more profitable than keeping complex version
 */
GLSL.prototype.optimizeDescriptor = function (descriptor) {
  //try to optimize

  if (this.optimize && descriptor.optimize !== false) {
    var complexity = descriptor.components.reduce(function (prev, curr) {
      return prev + curr.complexity||0;
    }, 0);

    if (complexity < descriptor.complexity) {
      //expand array, if complexity is ok
      if (descriptor.components && descriptor.components.length > 1) {
        var include = descriptor.components.map(function (c) { return c.include;}, this).filter(Boolean);
        // if it's mat, splice it into 2d array
        if (/mat/.test(descriptor.type)) {
          // get the dim of mat
          var cur_dim = parseInt(descriptor.type[3]);
          var newArr = [];
          var arr = descriptor.components;
          while(arr.length) newArr.push(arr.splice(0,cur_dim));
          descriptor.components = newArr;

          for (var id in descriptor.components) {
            descriptor.components[id] = descriptor.components[id].map(e => parseFloat(e));
          }

          return Descriptor(JSON.stringify(descriptor.components), {});
        }
        return Descriptor(`[${descriptor.components.join(', ')}]`, extend(descriptor, {
          include: include,
          complexity: complexity
        }));
      }
    }
  }

  return descriptor;
}


/**
 * Cache descriptor, return it
 */
GLSL.prototype.cache = function (node, value) {
  if (this.descriptors.has(node)) return this.descriptors.get(node);

  //force descriptor on save
  if (!(value instanceof String)) value = Descriptor(value);

  this.descriptors.set(node, value);

  return this.descriptors.get(node);
}



/**
 * List of transforms for various token types
 */
GLSL.prototype.transforms = {
  stmtlist: function (node) {
    if (!node.children.length) return Descriptor(null);

    var result = node.children.map(this.process, this).join('\n');

    return Descriptor(result);
  },

  stmt: function (node) {
    var result = node.children.map(this.process, this).join('');
    if (result) result += ';';

    return Descriptor(result);
  },

  struct: function (node) {
    var structName = node.children[0].data;

    //get args nodes
    var args = node.children.slice(1);
    var argTypes = [];

    //arg names
    var argsList = flatten(args.map(function (arg) {
      assert.equal(arg.type, 'decl', 'Struct statements should be declarations.');

      var decllist = arg.children[arg.children.length - 1];

      assert.equal(decllist.type, 'decllist', 'Struct statement declaration has wrong structure.');

      return decllist.children.map(function (ident) {
        assert.equal(ident.type, 'ident', 'Struct statement contains something other than just identifiers.');
        return ident.data;
      });
    }));

    var argTypes = flatten(args.map(function (arg) {
      var type = arg.children[4].token.data;
      var decllist = arg.children[arg.children.length - 1];
      return decllist.children.map(function () {
        return type;
      });
    }));

    var struct = function struct () {
      var args = arguments;

      var includes = [];

      var fields = argsList.map(function (argName, i) {
        if (args[i]) {
          var initValue = this.process(args[i]);
        }
        else {
          var initValue = this.types[argTypes[i]].call(this, args[i]);
        }
        initValue = this.optimizeDescriptor(initValue);
        includes = includes.concat(initValue.include);
        return Descriptor(`${argName}: ${initValue}`, {
          type: argTypes[i],
          optimize: false,
          components: initValue.components
        });
      }, this);

      return Descriptor(`{\n${fields.join(',\n')}\n}`, {
        type: structName,
        optimize: false,
        include: includes.filter(Boolean),
        components: fields
      });
    }.bind(this);

    //we should set length to be a compatible type constructor
    Object.defineProperty(struct, 'length', {value: argTypes.length});

    //register struct constructor, in a fashion of type constructors
    this.structs[structName] =
      this.types[structName] = struct;

    return Descriptor(null);
  },

  function: function (node) {
    var result = '';

    //if function has no body, that means it is interface for it. We can ignore it.
    if (node.children.length < 3) return Descriptor(null);

    //add function name - just render ident node
    assert.equal(node.children[0].type, 'ident', 'Function should have an identifier.');
    var name = this.process(node.children[0]);

    //add args
    assert.equal(node.children[1].type, 'functionargs', 'Function should have arguments.');
    var args = this.process(node.children[1]);

    //get out type of the function in declaration
    var outType = node.parent.children[4].token.data;


    //add argument types suffix to a fn
    var argTypesSfx = args.components.map(function (arg) {
      return `${arg.type}`;
    }).join('_');

    //if main name is registered - provide type-scoped name of function
    if (this.functions[name] && argTypesSfx) {
      name = `${name}_${argTypesSfx}`;
    }

    //add body
    assert.equal(node.children[2].type, 'stmtlist', 'Function should have a body.');

    //create function body
    result += `function ${name} (${args}) {\n`;
      result += this.process(node.children[2]);
      result = result.replace(/\n/g, '\n\t');
      result += '\n}';

    //get scope back to the global after fn ended
    this.currentScope = this.scopes[this.currentScope].__parentScope.__name;

    //create descriptor
    result = Descriptor(result, {
      type: outType,
      complexity: 999
    });

    //register function descriptor
    this.functions[name] = result;

    return result;
  },

  //function arguments are just shown as a list of ids
  functionargs: function (node) {
    //create new scope - func args are the unique token stream-style detecting a function entry
    var lastScope = this.currentScope;
    var scopeName = (node.parent && node.parent.children[0].data) || 'global';
    this.currentScope = scopeName;

    if (!this.scopes[scopeName]) {
      this.scopes[scopeName] = {
        __parentScope: this.scopes[lastScope],
        __name: scopeName
      };
    }

    var comps = node.children.map(this.process, this);

    return Descriptor(comps.join(', '), {
      components: comps
    });
  },

  //declarations are mapped to var a = n, b = m;
  //decl defines it’s inner placeholders rigidly
  decl: function (node) {
    var result;

    var nodeType = node.children[1];
    var typeNode = node.children[4];
    var decllist = node.children[5];
    //return Descriptor(`${typeNode.token.data}  ${decllist}`);

    //register structure
    if (node.token.data === 'struct') {
      this.process(typeNode);
      if (!decllist) return Descriptor(null);
    }


    assert(
        decllist.type === 'decllist' ||
        decllist.type === 'function' ||
        decllist.type === 'struct',
        'Decl structure is malicious');


    //declare function as hoisting one
    if (decllist.type === 'function') {
      return this.process(decllist);
    }

    //case of function args - drop var
    if (node.parent.type === 'functionargs') {
      result = this.process(decllist);
      return result;
    }
    //default type, like variable decl etc
    else {
      result = this.process(decllist);
    }

    //prevent empty var declaration
    if (!result || !result.trim()) return Descriptor(null, {
      type: result.type,
      components: result.components,
      optimize: false
    })

    var dataType = typeNode.token.data;
    if (dataType in this.varchanges) {
      dataType = this.varchanges[dataType];
    }

    return Descriptor(`${nodeType.token.data} ${dataType} ${result}`, {
      type: result.type,
      components: result.components,
      optimize: false
    });
  },


  //decl list is the same as in js, so just merge identifiers, that's it
  decllist: function (node) {
    var ids = [];
    for (var i = 0, l = node.children.length; i < l; i++) {
      var child = node.children[i];
      var ident = this.process(child);
      ids.push(ident);
    }
    var res = Descriptor(ids.join(', '));
    return res;
  },

  //placeholders are empty objects - ignore them
  placeholder: function (node) {
    return node.token.data;
  },

  //i++, --i etc
  suffix: function (node) {
    var str = this.process(node.children[0]);
    return Descriptor(str + node.data, {type: str.type});
  },

  //loops are the same as in js
  forloop: function (node) {
    var init = this.process(node.children[0]);
    var cond = this.process(node.children[1]);
    var iter = this.process(node.children[2]);
    var body = this.process(node.children[3]);

    return Descriptor(`for (${init}; ${cond}; ${iter}) {\n${body}\n}`, {

    });
  },

  whileloop: function (node) {
    var cond = this.process(node.children[0]);
    var body = this.process(node.children[1]);
    return Descriptor(`while (${cond}) {\n${body}\n}`, {
    });
  },

  operator: function (node) {
    //access operators - expand to arrays
    if (node.data === '.') {
      var identNode = node.children[0];
      var ident = this.process(identNode);
      var type = ident.type;
      var prop = node.children[1].data;

      return Descriptor(`${ident}.${prop}`, {
        type: type
      });
    }

    throw Error('Unknown operator ' + node.data);

    return Descriptor(null);
  },

  expr: function (node) {
    var result = node.children.map(this.process, this).join('');

    return Descriptor(result);
  },

  precision: function () {
    return Descriptor(null);
  },

  //FIXME: it never creates comments
  comment: function (node) {
    return Descriptor(null);
  },

  preprocessor: function (node) {
    return Descriptor('/* ' + node.token.data + ' */')
  },

  keyword: function (node) {
    if (node.data === 'true' || node.data === 'false') type = 'bool';
    //FIXME: guess every other keyword is a type, isn’t it?
    else type = node.data;
    return Descriptor(node.data, {
      type: type,
      complexity: 0,
      optimize: false
    });
  },

  ident: function (node) {
    //get type of registered var, if possible to find it
    var id = node.token.data;
    var scope = this.scopes[this.currentScope];

    //find the closest scope with the id
    while (scope[id] == null) {
      scope = scope.__parentScope;
      if (!scope) {
        // console.warn(`'${id}' is not defined`);
        break;
      }
    }

    var str = node.data;

    if (scope) {
      var type = scope[id].type;
      var res = Descriptor(str, {
        type: type,
        complexity: 0
      });

      return res;
    }


    //FIXME: guess type more accurately here
    return Descriptor(str, {
      complexity: 0
    });
  },

  return: function (node) {
    var expr = this.process(node.children[0]);
    return Descriptor('return' + (expr.visible ? ' ' + expr : ''), {type: expr.type});
  },

  continue: function () {return Descriptor('continue')},

  break: function () {return Descriptor('break')},

  discard:  function () {return Descriptor('discard()')},

  'do-while': function (node) {
    var exprs = this.process(node.children[0]);
    var cond = this.process(node.children[1]);
    return Descriptor(`do {\n${exprs}\n} while (${cond})`, {
    });
  },

  binary: function (node) {
    var result = '';
    var leftNode = node.children[0];
    var rightNode = node.children[1];
    var left = this.process(leftNode);
    var right = this.process(rightNode);
    var leftType = left.type;
    var rightType = right.type;
    var operator = node.data;
    return this.processOperation(left, right, operator);
  },

  assign: function (node) {
    var result = '';
    var operator = node.data;

    var right = this.process(node.children[1]);
    var left = Descriptor(node.children[0].data, {
      type: right.type,
      optimize: false,
      complexity: 0
    });

    if (node.children[0].type === 'identifier') {
      var left = Descriptor(node.children[0].data, {
        type: right.type,
        optimize: false,
        complexity: 0
      });
    }
    else {
      var left = this.process(node.children[0]);
    }
    return Descriptor(`${left} ${operator} ${right}`, {
      type: right.type,
      complexity: 1
    });
  },

  ternary: function (node) {
    var cond = this.process(node.children[0]);
    var a = this.process(node.children[1]);
    var b = this.process(node.children[2]);

    return Descriptor(`${cond} ? ${a} : ${b}`, {type: a.type});
  },

  unary: function (node) {
    var str = this.process(node.children[0]);

    var complexity = str.complexity + 1;

    //ignore + operator, we dont need to cast data
    if (node.data === '+') {
      //++x
      if (node.children[0].type === 'unary') {
        return Descriptor(node.data + str, {type: str.type, complexity: complexity});
      }
      else if (node.children[0].parent.type === 'unary') {
        return Descriptor(node.data + str, {type: str.type, complexity: complexity});
      }

      //+x
      return Descriptor(str);
    }
    return Descriptor(node.data + str, {type: str.type, complexity: complexity});
  },

  //gl_Position, gl_FragColor, gl_FragPosition etc
  builtin: function (node) {
    return Descriptor(node.data, {
      type: this.builtins[node.data],
      complexity: 0
    });
  },

  call: function (node) {
    var args = node.children.slice(1);
    var argValues = args.map(this.process, this);
    var argTypes = argValues.map(function (arg) {
      return arg.type
    }, this);

    //if first node is an access, like a.b() - treat special access-call case
    if (node.children[0].data === '.') {
      var methodNode = node.children[0].children[1];
      var holderNode = node.children[0].children[0];
      var methodName = this.process(methodNode);
      var holderName = this.process(holderNode);
      var type = holderName.type;

      var callName = Descriptor(`${holderName}.${methodName}`, {
        type: methodName.type,
        complexity: holderName.complexity + methodName.complexity
      });
    }

    //first node is caller: float(), float[2](), vec4[1][3][4]() etc.
    else {
      var callName = this.process(node.children[0]);
    }


    //someFn()
    var type, optimize = true;

    //stdlib()
    if (this.stdlib[callName]) {
      this.addInclude(callName);

      //if callname is other than included name - redirect call name
      if (this.stdlib[callName].name) {
        callName = this.stdlib[callName].name;
      }

      //add other includes if any
      this.addInclude(this.stdlib[callName].include);

      type = this.stdlib[callName].type;
      if (type instanceof Function) type = type.call(this, node);
    }

    if (!type) {
      //Unable to guess the type of '${callName}' as it is undefined. Guess it returns the type of the first argument.
      type = this.process(node.children[1]).type;
      optimize = false;
    }
    
    //chaneg call Name to callchanges
    if (callName in this.callchanges) {
      callName = this.callchanges[callName];
    }

    var res = Descriptor(`${callName}(${argValues.join(', ')})`, {
      type: type || callName.type,
      complexity: 999 /* argValues.reduce(function (prev, curr) {
                         return curr.complexity+prev;
                         }, callName.complexity||999) */,
        optimize: optimize
    });

    return res;
  },

  literal: function (node) {
    //convert float to int 
    if (floatRE.test(node.data)) {
      node.data = node.data.split('.')[0];
    }
    var result = /^[0-9][xob]/.test(node.data) ? Number(node.data) : node.data;
    //guess type - as far in js any number tends to be a float, give priority to it
    //in order to avoid unnecessary types alignment
    var type;
    if (/true|false/i.test(node.data)) type = 'bool';
    else if (/^[0-9]+$/.test(node.data) > 0) type = 'int';
    else if (floatRE.test(node.data)) type = 'float';
    return Descriptor(result, {type: type, complexity: 0});
  },

  //ifs are the same as js
  if: function (node) {
    var cond = this.process(node.children[0]);
    var ifBody = this.process(node.children[1]);

    var result = `if (${cond}) {\n${ifBody}\n}`;

    if (node.children.length > 1) {
      var elseBody = this.process(node.children[2]);
      if (elseBody.visible) result += ` else {\n${elseBody}\n}`;
    }

    return Descriptor(result, {
      type: 'float'
    });
  },

  //grouped expression like a = (a - 1);
  group: function (node) {
    //children are like (1, 2, 3) - does not make a big sense
    //the last one is always taken as a result
    var children = node.children.map(this.process, this);

    var result = '(' + children.join(', ') + ')';
    var last = children[children.length - 1];

    //each component therefore should be wrapped to group as well
    //FIXME: single-multiplocation ops like (x*34.) + 1. are possible to be unwrapped, providing that they are of the most precedence.
    last.components = last.components.map(function (comp) {
      //if component contains no operations (we not smartly guess that each op adds to complexity) - keep component as is.
      if (comp.complexity === 1) return comp;

      //otherwise wrap it, as it may contain precedences etc.
      return Descriptor('(' + comp + ')', comp);
    });

    return Descriptor(result, {
      type: last.type,
      components: last.components,
      complexity: children.reduce(function (prev, curr) {return prev+curr.complexity||0}, 0)
    });
  }
}

/**
 * Return list if ids for swizzle letters
 */
GLSL.prototype.swizzlePositions = function (prop) {
  var swizzles = 'xyzwstpdrgba';
  var positions = [];
  for (var i = 0, l = prop.length; i < l; i++) {
    var letter = prop[i];
    var position = swizzles.indexOf(letter) % 4;
    positions.push(position);
  }
  return positions;
};

/**
 * Transform access node to a swizzle construct
 * ab.xyz → [ab[0], ab[1], ab[2]]
 */
GLSL.prototype.unswizzle = function (node) {
  var identNode = node.children[0];

  var ident = this.process(identNode);
  var type = ident.type;
  var prop = node.children[1].data;

  var positions = this.swizzlePositions(prop),
  args = positions.map(function (position) {
    //[0, 1].yx → [0, 1]
    // a.yx → [a[1], a[0]]
    return ident.components[position];
  });
  //a.x → a[0]
  if (args.length === 1) {
    if (args[0] == null) console.warn(`Cannot unswizzle '${ident.type}(${ident}).${prop}': ${prop} is outside the type range.`);
    var result = Descriptor(args[0]||'undefined', {
      type: 'float',
      complexity: 1
    });
    return result;
  }

  var complexity = args.length * ident.complexity;

  //a.yz → [1, 2].map(function(x) { return this[x]; }, a)
  var result = Descriptor(`[${positions.join(', ')}].map(function (x, i) { return this[x]}, ${ident})`, {
    complexity: args.length*2,
    type: `vec${args.length}`,
    components: args
  });

  result = this.optimizeDescriptor(result);

  return result;
}


/**
 * Get/set variable from/to a [current] scope
 */
GLSL.prototype.variable = function (ident, data, scope) {
  if (!scope) scope = this.currentScope;

  //set/update variable
  if (data) {
    //create variable
    if (!this.scopes[scope][ident]) {
      this.scopes[scope][ident] = {};
    }
    //if value is passed - we guess that variable knows how to init itself
    //usually it is `call` node rendered
    // else {
    // }


    //just set an id
    if (variable.id == null) variable.id = ident;

    //save scope
    if (variable.scope == null) variable.scope = this.scopes[scope];

    //save variable to the collections
    if (variable.binding === 'uniform') {
      this.uniforms[ident] = variable;
    }
    if (variable.binding === 'attribute') {
      this.attributes[ident] = variable;
    }
    if (variable.binding === 'varying') {
      this.varyings[ident] = variable;
    }

    return variable;
  }

  //get varialbe
  return this.scopes[scope][ident];
};


/**
 * Return value wrapped to the proper number of dimensions
 */
GLSL.prototype.wrapDimensions = function (value, dimensions) {
  //wrap value to dimensions
  if (dimensions.length) {
    if (!Array.isArray(value)) value = [value];

    value = dimensions.reduceRight(function (value, curr) {
      var result = [];

      //for each dimension number - wrap result n times
      var prevVal, val;
      for (var i = 0; i < curr; i++) {
        val = value[i] == null ? prevVal : value[i];
        prevVal = val;
        result.push(val);
      }
      return `[${result.join(', ')}]`;
    }, value);
  }

  return value;
};


/**
 * Operator renderer
 */
GLSL.prototype.processOperation = operators;


/**
 * Add include, pass optional prop object
 */
GLSL.prototype.addInclude = function (name, prop) {
  if (!name) return;

  if (Array.isArray(name)) {
    return name.forEach(function (i) {
      this.addInclude(i)
    }, this);
  }

  if (!(name instanceof String) && typeof name === 'object') {
    for (var subName in name) {
      this.addInclude(subName, name[subName]);
    }
    return;
  }

  if (!prop) {
    if (!this.includes[name]) this.includes[name] = true;
  }
  else {
    if (!this.includes[name] || this.includes[name] === true) this.includes[name] = {};
    this.includes[name][prop] = true;
  }
}


/**
 * Get stdlib source for includes
 */
GLSL.prototype.stringifyStdlib = function (includes) {
  if (!includes) includes = this.includes;
  var methods = [];

  for (var meth in includes) {
    //eg vecN
    var result = this.stdlib[meth].toString();
    methods.push(result);

    //eg vecN.operation
    if (includes[meth]) {
      for (var prop in includes[meth]) {
        if (!this.stdlib[meth][prop]) {
          console.warn(`Cannot find '${meth}.${prop}' in stdlib`);
          continue;
        }
        methods.push(`${meth}.${prop} = ${this.stdlib[meth][prop].toString()}`);
      }
    }
  }

  return methods.join('\n');
};


module.exports = GLSL;
