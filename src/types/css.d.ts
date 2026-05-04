import 'react';

declare module 'react' {
  interface CSSProperties {
    [cssVariable: `--${string}`]: string | number | undefined;
  }
}
