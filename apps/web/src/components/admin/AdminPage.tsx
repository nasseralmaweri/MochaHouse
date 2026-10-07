// The content region wrapper every Admin page renders inside the shell.
// Owns the max-width, horizontal centering and padding so pages stop
// hand-rolling their own <main> layout. The shell provides the <main>
// landmark and id="admin-content"; this is a plain <div> inside it.
export function AdminPage({
  children,
  width = "default",
}: {
  children: React.ReactNode;
  // "wide" is for overview-style pages whose primary content is a table or
  // a figure row and benefits from large monitors.
  width?: "default" | "wide";
}) {
  return (
    <div
      className={`mx-auto flex w-full ${
        width === "wide" ? "max-w-[88rem]" : "max-w-6xl"
      } flex-col gap-8 px-5 py-8 sm:px-8 lg:px-10 2xl:px-14`}
    >
      {children}
    </div>
  );
}

export function AdminSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-lg font-semibold tracking-tight text-text-primary">
          {title}
        </h2>
        {description ? (
          <p className="text-sm text-text-secondary">{description}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}
