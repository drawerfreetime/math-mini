import React from 'react';

/** Large frame: glow wrapper + bordered inner panel */
export default function HudFrame({ children, className = '', style }) {
  const wrapCls = `big-frame-glow${className ? ` ${className}` : ''}`;
  return React.createElement(
    'div',
    { className: wrapCls, style },
    React.createElement('section', { className: 'big-frame' }, children),
  );
}
