import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { Import } from './Import';
import './styles.css';

/** Two screens, switched by the URL hash: the shop chat (default) and `#import` for operators. */
function Root() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const onChange = () => setHash(location.hash);
    addEventListener('hashchange', onChange);
    return () => removeEventListener('hashchange', onChange);
  }, []);
  return hash === '#import' ? <Import /> : <App />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
