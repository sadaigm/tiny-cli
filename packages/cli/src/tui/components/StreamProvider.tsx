import React, { createContext, useContext } from 'react';
import { StreamStore } from '../streamStore.js';

/**
 * Provides the {@link StreamStore} instance to the log-pane subtree.
 * The store is created once by <App>; this context just hands it down so
 * panels can subscribe without prop-drilling.
 */
const StreamContext = createContext<StreamStore | null>(null);

export function StreamProvider({ store, children }: {
  store: StreamStore;
  children: React.ReactNode;
}): React.ReactElement {
  return <StreamContext.Provider value={store}>{children}</StreamContext.Provider>;
}

export function useStreamStore(): StreamStore {
  const store = useContext(StreamContext);
  if (!store) throw new Error('useStreamStore must be used inside <StreamProvider>');
  return store;
}
