import { LoaderCircle } from "lucide-react";
import { useRef, useState } from "react";
import { LinkedText } from "./LinkedText";

type Outgoing = { key: number; body: string };

/**
 * A message is in the thread the moment Send is pressed, marked as sending,
 * rather than appearing a round trip later. It leaves the outbox only once the
 * reload has brought the real one in, so the thread never blinks empty in
 * between. A refusal takes it out again, puts the text back in the box and
 * says why.
 */
export function useOutbox() {
  const [items, setItems] = useState<Outgoing[]>([]);
  const [error, setError] = useState<string>();
  const nextKey = useRef(0);
  const drop = (key: number) => setItems((current) => current.filter((i) => i.key !== key));

  async function post(body: string, send: (body: string) => Promise<unknown>, reload: () => Promise<void>, restore: (body: string) => void) {
    const key = nextKey.current++;
    setError(undefined);
    setItems((current) => [...current, { key, body }]);
    try {
      await send(body);
    } catch (err) {
      drop(key);
      restore(body);
      setError(`Not sent — ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
    try {
      await reload();
    } finally {
      drop(key);
    }
  }

  return { items, error, post };
}

export function OutgoingComments({ items, author }: { items: Outgoing[]; author: string }) {
  return (
    <>
      {items.map((item) => (
        <div className="comment pending" key={`out-${item.key}`}>
          <strong dir="auto">{author}</strong>
          <small className="save-state" role="status">
            <LoaderCircle size={12} className="spin" aria-hidden="true" /> Sending…
          </small>
          <p><LinkedText text={item.body} /></p>
        </div>
      ))}
    </>
  );
}
