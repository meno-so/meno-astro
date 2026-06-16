import { test, expect, describe } from 'bun:test';
import { wrapDefineVarsJs, unwrapDefineVarsJs } from './scriptBind';

describe('scriptBind — define:vars el + props binding', () => {
  const JS = "const c = props.columns;\nel.querySelector('.x');";

  test('wrap binds both el and props (object of the injected names)', () => {
    const wrapped = wrapDefineVarsJs(JS, ['columns', 'gap']);
    expect(wrapped.startsWith('(function(el, props){')).toBe(true);
    expect(wrapped).toContain('document.currentScript'); // el bound from script position
    expect(wrapped).toContain(', { columns, gap });'); // props built from define:vars consts
    expect(wrapped).toContain(JS); // user body verbatim
  });

  test('round-trips: unwrap recovers the exact user JS', () => {
    expect(unwrapDefineVarsJs(wrapDefineVarsJs(JS, ['columns', 'gap']))).toBe(JS);
    expect(unwrapDefineVarsJs(wrapDefineVarsJs(JS, []))).toBe(JS); // no names → props = {}
  });

  test('back-compat: still unwraps the previous el-only wrapper form', () => {
    const EL =
      '(function(){var s=document.currentScript,e=s&&s.previousElementSibling;' +
      "while(e&&(e.nodeName==='STYLE'||e.nodeName==='SCRIPT'))e=e.previousElementSibling;return e||null;})()";
    const oldForm = `(function(el){\n${JS}\n})(${EL});`;
    expect(unwrapDefineVarsJs(oldForm)).toBe(JS);
  });

  test('non-wrapped JS passes through untouched', () => {
    expect(unwrapDefineVarsJs('console.log(1);')).toBe('console.log(1);');
  });
});
