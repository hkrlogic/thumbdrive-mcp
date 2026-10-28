// Progressive enhancement only: every page works without this file.
document.addEventListener("submit", (event) => {
  const message = event.target.dataset.confirm;
  if (message && !window.confirm(message)) event.preventDefault();
});
for (const pre of document.querySelectorAll("pre.copyable")) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Copy";
  button.addEventListener("click", async () => {
    await navigator.clipboard.writeText(pre.textContent);
    button.textContent = "Copied";
  });
  pre.after(button);
}
