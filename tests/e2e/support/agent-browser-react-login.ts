import { createElement as h, useState } from "react";
import { createRoot } from "react-dom/client";

function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [stage, setStage] = useState("login");
  const [submitted, setSubmitted] = useState("");
  const [code, setCode] = useState("");
  if (stage === "login") return h("form", {
    onSubmit: (event) => {
      event.preventDefault();
      setSubmitted(password);
      console.error(password);
      setStage("mfa");
    },
  }, h("h1", null, "Sign in"),
  h("label", null, "Username", h("input", { id: "username", value: username,
    onChange: (event) => setUsername(event.target.value) })),
  h("label", null, "Password", h("input", { id: "password", type: "password", value: password,
    onChange: (event) => setPassword(event.target.value) })),
  h("label", null, "Backup password", h("input", { id: "backup", type: "password", defaultValue: "" })),
  h("button", { type: "submit" }, "Sign in"));
  if (stage === "mfa") return h("form", {
    onSubmit: (event) => { event.preventDefault(); setStage("done"); },
  }, h("h1", null, "Verify your identity"),
  h("p", null, `Signed in as ${username}`),
  h("label", null, "Authentication code", h("input", { id: "code", autoComplete: "one-time-code",
    value: code, onChange: (event) => setCode(event.target.value) })),
  h("p", null, submitted),
  h("button", { type: "submit" }, "Verify"));
  return h("main", null, h("h1", null, "Welcome back"), h("p", null, `Signed in as ${username}`),
    h("p", null, submitted), h("p", null, code),
    h("button", { "aria-label": `Open ${submitted}`, type: "button" }, "Open account"));
}

createRoot(document.getElementById("root")!).render(h(Login));
