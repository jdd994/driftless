// Toast.tsx
export type ToastData = { msg: string; action?: { label: string; fn: () => void } } | null;

export function Toast({ toast, onDismiss }: { toast: ToastData; onDismiss: () => void }) {
  return (
    <div className={"toast" + (toast ? " show" : "")} role="status">
      <span>{toast?.msg}</span>
      {toast?.action && (
        <button
          onClick={() => {
            toast.action!.fn();
            onDismiss();
          }}
        >
          {toast.action.label}
        </button>
      )}
    </div>
  );
}
