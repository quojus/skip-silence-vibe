// Seitenskript der E2E-Testseite: stellt drei Arten von Medienelementen bereit.
customElements.define(
  "shadow-player",
  class extends HTMLElement {
    constructor() {
      super();
      const root = this.attachShadow({ mode: "closed" });
      this.audio = document.createElement("audio");
      this.audio.src = "fixtures/ton_pause.wav";
      root.append(this.audio);
    }
  },
);

window.__players = {
  dom: () => document.getElementById("dom"),
  shadow: () => document.getElementById("shadow").audio,
  detached: (() => {
    let a = null;
    return () => (a ??= new Audio("fixtures/ton_pause.wav"));
  })(),
};
