import { useEffect, useRef, useState } from "react";

/** An imperative request that does not own a query cache (email, resend, reveal).
 * Query-changing operations continue to use useMutation with explicit cache updates. */
export function useAction<T, V = void>({ mutationFn, onSuccess, onError }: {
  mutationFn: (variables: V) => Promise<T>;
  onSuccess?: (data: T, variables: V) => void;
  onError?: (error: Error) => void;
}) {
  const [state, setState] = useState<{ data?: T; error: Error | null; isPending: boolean }>({ error: null, isPending: false });
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  function mutate(variables: V) {
    const request = ++generation.current;
    setState({ error: null, isPending: true });
    void Promise.resolve().then(() => mutationFn(variables)).then(data => {
      if (request !== generation.current) return;
      setState({ data, error: null, isPending: false });
      onSuccess?.(data, variables);
    }, reason => {
      if (request !== generation.current) return;
      const error = reason instanceof Error ? reason : new Error(String(reason));
      setState({ error, isPending: false });
      onError?.(error);
    });
  }
  function reset() {
    generation.current++;
    setState({ error: null, isPending: false });
  }
  return { ...state, mutate, reset };
}
