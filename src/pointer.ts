import type { TUI, TuiMouseEvent } from "@earendil-works/pi-tui";

/** pi-tui's fullscreen TUI routes mouse events through this private method. */
interface LayoutDispatcher {
  dispatchMouseToLayout?: (event: TuiMouseEvent) => unknown;
}

/**
 * Runs `around` for every pointer move the TUI dispatches, wherever it lands. pi sends moves only
 * to the component under the pointer and consumes mouse input before extensions see it, so a
 * component cannot otherwise tell that the pointer left it. This wraps a private TUI method, as
 * pi-cc-extensions does; if the method is missing, nothing is observed. Returns an undo function.
 */
export function aroundPointerMoves(
  tui: TUI,
  around: (dispatch: () => unknown) => unknown,
): () => void {
  const target = tui as unknown as LayoutDispatcher;
  const original = target.dispatchMouseToLayout;
  if (typeof original !== "function") return () => {};
  const hadOwn = Object.hasOwn(target, "dispatchMouseToLayout");
  const wrapper = function (this: unknown, event: TuiMouseEvent) {
    const dispatch = () => original.call(this, event);
    return event.type === "move" ? around(dispatch) : dispatch();
  };
  target.dispatchMouseToLayout = wrapper;
  return () => {
    // Another wrapper installed later keeps calling ours; leave the chain intact.
    if (target.dispatchMouseToLayout !== wrapper) return;
    if (hadOwn) target.dispatchMouseToLayout = original;
    else delete target.dispatchMouseToLayout;
  };
}
