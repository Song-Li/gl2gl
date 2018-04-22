var GLSL = require('./');
var compile = GLSL.compile;

var src = `attribute vec3 vertPosition;
attribute vec2 vertTexCoord;
attribute vec3 vertNormal;

varying vec2 fragTexCoord;
varying vec3 fragNormal;

uniform mat4 mWorld;
uniform mat4 mView;
uniform mat4 mProj;
uniform mat3 test;

void main()
{
  fragTexCoord = vertTexCoord;
  fragNormal = (mWorld * vec4(vertNormal, 0.0)).xyz;
  mProj += mProj;
  mProj /= mProj;
  if (fragTexCoord == vertNormal) {
    gl_Position = mProj * mView * mWorld * vec4(vertPosition, 1.0);
    gl_Position = gl_Position + gl_Position;
  }else {
    gl_Position = mProj;
    gl_Position = mProj - mView;
  }
}`
console.log(compile(src));
