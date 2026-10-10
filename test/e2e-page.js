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

// Eingabefeld in einem geschlossenen Shadow DOM (die Spul-Taste darf dort nicht greifen)
customElements.define(
  "shadow-input",
  class extends HTMLElement {
    constructor() {
      super();
      const root = this.attachShadow({ mode: "closed" });
      this.input = document.createElement("input");
      root.append(this.input);
    }
  },
);
window.__shadowInput = () => document.getElementById("sinput").input;

window.__players = {
  dom: () => document.getElementById("dom"),
  shadow: () => document.getElementById("shadow").audio,
  detached: (() => {
    let a = null;
    return () => (a ??= new Audio("fixtures/ton_pause.wav"));
  })(),
};
