const appRoot = document.querySelector("#app");
const assetBaseUrl = new URL(".", document.currentScript.src);

// Única fuente de preguntas. Cada pregunta debe tener un id numérico único,
// question y options: [{ text, isCorrect }], con una sola respuesta correcta.
// image es opcional y contiene una ruta relativa al JSON en data/.
const subjects = {
  bank: { label: "Banco de preguntas", description: "Banco completo de preguntas de Odoo 19." },
  revision: {
    label: "Pendientes de curar",
    description: "Preguntas marcadas como dudosas en el informe de revisión.",
    warning: "Preguntas aún por curar. No se garantiza que las respuestas sean correctas.",
  },
};
const countOptions = [30, 60, 90, 120, "custom"];

const initialState = {
  view: "config",
  selectedSubject: "bank",
  selectedCount: null,
  customCount: "",
  session: null,
  reviewIndex: 0,
};

let appState = { ...initialState };

render();

function render() {
  if (appState.view === "config") {
    renderConfig();
    return;
  }

  if (appState.view === "quiz") {
    renderQuiz();
    return;
  }

  renderResults();
}

function renderConfig() {
  const subjectButtons = Object.entries(subjects)
    .map(([id, subject]) => `<button class="${appState.selectedSubject === id ? "primary" : ""}" data-action="select-subject" data-subject="${id}" aria-pressed="${appState.selectedSubject === id}">${subject.label}</button>`)
    .join("");
  const countButtons = countOptions
    .map((countValue) => {
      const selectedClass = appState.selectedCount === countValue ? "primary" : "";
      const label = getCountLabel(countValue);
      return `<button class="${selectedClass}" data-action="select-count" data-count="${countValue}">${label}</button>`;
    })
    .join("");

  const showCustomInput = appState.selectedCount === "custom";

  appRoot.innerHTML = `
    <section class="card">
      <h1>Certificación funcional de Odoo</h1>
      <fieldset class="subject-picker">
        <legend>Tema</legend>
        <div class="actions">${subjectButtons}</div>
      </fieldset>
      <p>${subjects[appState.selectedSubject].description}</p>
      ${renderSubjectNotice(appState.selectedSubject)}
      <p>Practica en bloques de 30, 60 o 90 preguntas, prepara un examen de 120 o elige una cantidad personalizada.</p>
      <div class="actions">${countButtons}</div>
      ${
        showCustomInput
          ? `
        <div style="margin-top: 0.75rem;">
          <label for="custom-count">Número de preguntas</label>
          <input id="custom-count" type="number" min="1" step="1" placeholder="Escribe una cantidad" value="${escapeHtml(
            appState.customCount
          )}" />
        </div>
      `
          : ""
      }
      <div class="actions" style="margin-top: 0.75rem;">
        <button class="primary" data-action="start-quiz" ${appState.selectedCount === null ? "disabled" : ""}>Comenzar</button>
      </div>
    </section>
  `;

  appRoot.querySelectorAll('[data-action="select-subject"]').forEach((button) => {
    button.addEventListener("click", () => {
      setState({ ...appState, selectedSubject: button.dataset.subject });
    });
  });

  appRoot.querySelectorAll('[data-action="select-count"]').forEach((button) => {
    button.addEventListener("click", () => {
      const rawCount = button.dataset.count;
      const countValue = rawCount && Number.isNaN(Number(rawCount)) ? rawCount : Number(rawCount);

      setState({
        ...appState,
        selectedCount: countValue,
      });
    });
  });

  const customCountInput = appRoot.querySelector("#custom-count");
  if (customCountInput) {
    customCountInput.addEventListener("input", (event) => {
      appState.customCount = event.target.value;
    });
  }

  appRoot.querySelector('[data-action="start-quiz"]').addEventListener("click", startQuiz);
}

async function startQuiz() {
  const questionCount = resolveQuestionCount();
  if (!questionCount) {
    window.alert("Selecciona una cantidad válida de preguntas (un número entero mayor que cero).");
    return;
  }

  const subjectId = appState.selectedSubject;
  let questions;
  try {
    questions = await loadQuestions(subjectId);
  } catch (error) {
    window.alert(`No se pudo cargar el tema seleccionado. ${error.message}`);
    return;
  }
  if (!questions.length) {
    window.alert("El tema seleccionado no contiene preguntas.");
    return;
  }

  if (questionCount > questions.length) {
    window.alert(`Este bloque necesita ${questionCount} preguntas y el tema contiene ${questions.length}. Elige un bloque menor o una cantidad personalizada.`);
    return;
  }

  const shuffledQuestions = fisherYatesShuffle([...questions]).slice(0, questionCount);
  const preparedQuestions = shuffledQuestions.map((questionItem) => ({
    ...questionItem,
    options: fisherYatesShuffle([...questionItem.options]),
  }));

  setState({
    ...appState,
    view: "quiz",
    selectedSubject: subjectId,
    reviewIndex: 0,
    session: {
      subjectId,
      index: 0,
      score: 0,
      questions: preparedQuestions,
      answers: {},
    },
  });
}

async function loadQuestions(subjectId = appState.selectedSubject) {
  if (assetBaseUrl.protocol === "file:") {
    throw new Error("El navegador bloquea los JSON al abrir index.html como archivo local (file://). Abre la web publicada en GitHub Pages o usa un servidor local: python3 -m http.server 8000 y entra en http://localhost:8000.");
  }
  if (!Object.hasOwn(subjects, subjectId)) throw new Error("El tema seleccionado no existe.");
  const bankUrl = new URL("data/odoo.json", assetBaseUrl);
  const payload = await loadJson(bankUrl);
  if (!Array.isArray(payload) || !payload.every(isValidQuestion)) {
    throw new Error("data/odoo.json contiene preguntas con un formato no válido.");
  }
  if (new Set(payload.map((question) => question.id)).size !== payload.length) {
    throw new Error("data/odoo.json contiene identificadores de pregunta duplicados.");
  }
  let questions = payload;
  if (subjectId === "revision") {
    const report = await loadJson(new URL("data/odoo_revision.json", assetBaseUrl));
    if (!report || !Array.isArray(report.questions)) throw new Error("data/odoo_revision.json no contiene un informe de revisión válido.");
    const questionIds = new Set(payload.map((question) => question.id));
    if (!report.questions.every((item) => item && questionIds.has(item.id) && typeof item.status === "string")) {
      throw new Error("El informe de revisión contiene referencias a preguntas no válidas.");
    }
    if (new Set(report.questions.map((item) => item.id)).size !== report.questions.length) {
      throw new Error("El informe de revisión contiene identificadores duplicados.");
    }
    const pending = new Map(report.questions.filter((item) => item.status === "duda").map((item) => [item.id, item]));
    questions = payload.filter((question) => pending.has(question.id)).map((question) => ({
      ...question,
      reviewReason: pending.get(question.id).reason,
    }));
  }
  return questions.map((question) => ({
    ...question,
    ...(question.image ? { image: new URL(question.image, bankUrl).href } : {}),
  }));
}

async function loadJson(url) {
  let response;
  try {
    response = await fetch(url, { cache: "no-cache" });
  } catch {
    throw new Error(`No hay conexión con ${url.href}. Comprueba tu conexión e inténtalo de nuevo.`);
  }
  if (!response.ok) {
    throw new Error(`No se pudo descargar ${url.pathname} (HTTP ${response.status}). Comprueba que el archivo esté incluido en la publicación.`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`${url.pathname} no contiene JSON válido.`);
  }
}

function isValidQuestion(questionItem) {
  if (!questionItem || typeof questionItem !== "object") return false;
  if (!Number.isSafeInteger(questionItem.id)) return false;
  if (typeof questionItem.question !== "string" || !questionItem.question.trim()) return false;
  if (questionItem.image !== undefined && (typeof questionItem.image !== "string" || !questionItem.image.trim())) return false;
  // Algunas entradas del banco solo incluyen la respuesta documentada.
  if (!Array.isArray(questionItem.options) || questionItem.options.length < 1) return false;

  return questionItem.options.every((optionItem) => {
    return optionItem && typeof optionItem.text === "string" && optionItem.text.trim() && typeof optionItem.isCorrect === "boolean";
  }) && questionItem.options.filter((optionItem) => optionItem.isCorrect).length === 1;
}

function renderQuiz() {
  const session = appState.session;
  if (!session || !session.questions.length) {
    goHome();
    return;
  }

  const currentQuestion = session.questions[session.index];
  const selectedOptionIndex = session.answers[currentQuestion.id];
  const isAnswered = selectedOptionIndex !== undefined;
  const progressPercent = Math.round((session.index / session.questions.length) * 100);
  const nextButtonLabel = session.index === session.questions.length - 1 ? "Ver resultado" : "Siguiente";

  const optionsMarkup = currentQuestion.options
    .map((optionItem, optionIndex) => {
      const selected = selectedOptionIndex === optionIndex;
      const isCorrect = isAnswered && optionItem.isCorrect;
      const isWrong = isAnswered && selected && !optionItem.isCorrect;
      const isDimmed = isAnswered && !selected && !optionItem.isCorrect;

      const classes = ["option"];
      if (isCorrect) classes.push("correct");
      if (isWrong) classes.push("wrong");
      if (isDimmed) classes.push("dimmed");

      return `<button class="${classes.join(" ")}" data-action="select-option" data-index="${optionIndex}" ${
        isAnswered ? "disabled" : ""
      }>${escapeHtml(optionItem.text)}</button>`;
    })
    .join("");

  appRoot.innerHTML = `
    <section class="progress">
      <div class="progress-meta">
        <span>Pregunta ${session.index + 1} de ${session.questions.length}</span>
        <span>${progressPercent}%</span>
      </div>
      <div class="progress-track" aria-hidden="true">
        <div class="progress-fill" style="width: ${progressPercent}%;"></div>
      </div>
    </section>

    <section class="card">
      <p>${subjects[session.subjectId].label}</p>
      ${renderSubjectNotice(session.subjectId)}
      <h3>${escapeHtml(currentQuestion.question)}</h3>
      ${renderQuestionImage(currentQuestion)}
      <div class="options-list">${optionsMarkup}</div>
      <p class="helper">${isAnswered ? "Respuesta guardada." : "Selecciona una respuesta para continuar."}</p>
      ${isAnswered && currentQuestion.reviewReason ? `<p class="helper">Motivo de revisión: ${escapeHtml(currentQuestion.reviewReason)}</p>` : ""}
    </section>

    <div class="next-bar">
      <div class="next-bar-inner">
        <button class="primary" data-action="next-step" ${isAnswered ? "" : "disabled"}>${nextButtonLabel}</button>
      </div>
    </div>
  `;

  appRoot.querySelectorAll('[data-action="select-option"]').forEach((button) => {
    button.addEventListener("click", () => {
      const optionIndex = Number(button.dataset.index);
      answerQuestion(optionIndex);
    });
  });

  appRoot.querySelector('[data-action="next-step"]').addEventListener("click", goToNextStep);
}

function answerQuestion(optionIndex) {
  const session = appState.session;
  if (!session) return;

  const currentQuestion = session.questions[session.index];
  const selectedOption = currentQuestion.options[optionIndex];
  if (!selectedOption) return;

  if (session.answers[currentQuestion.id] !== undefined) {
    return;
  }

  const nextScore = selectedOption.isCorrect ? session.score + 1 : session.score;

  setState({
    ...appState,
    session: {
      ...session,
      score: nextScore,
      answers: {
        ...session.answers,
        [currentQuestion.id]: optionIndex,
      },
    },
  });
}

function goToNextStep() {
  const session = appState.session;
  if (!session) return;

  const isLastQuestion = session.index >= session.questions.length - 1;
  if (isLastQuestion) {
    setState({
      ...appState,
      view: "results",
    });
    return;
  }

  setState({
    ...appState,
    session: {
      ...session,
      index: session.index + 1,
    },
  });
}

function renderResults() {
  const session = appState.session;
  if (!session) {
    goHome();
    return;
  }

  const totalQuestions = session.questions.length;
  const resultPercent = Math.round((session.score / totalQuestions) * 100);

  const mistakes = session.questions.filter(q => {
    const userChoiceIdx = session.answers[q.id];
    return !q.options[userChoiceIdx].isCorrect;
  });

  appRoot.innerHTML = `
    <section class="card">
      <h2>Resultado final</h2>
      <p>${subjects[session.subjectId].label}</p>
      ${renderSubjectNotice(session.subjectId)}
      <p>Has acertado ${session.score} de ${totalQuestions} preguntas.</p>
      <h3>${resultPercent}% de aciertos</h3>
      <div class="actions single-column" style="margin-top: 0.75rem;">
        <button class="primary" data-action="retry">Reintentar</button>
        <button class="ghost" data-action="go-home">Volver al inicio</button>
      </div>
    </section>
    
    <div id="review-section">
      ${mistakes.length > 0 ? renderReview(mistakes) : ""}
    </div>
  `;

  appRoot.querySelector('[data-action="retry"]').addEventListener("click", retryQuiz);
  appRoot.querySelector('[data-action="go-home"]').addEventListener("click", goHome);

  const prevBtn = appRoot.querySelector('[data-action="prev-mistake"]');
  const nextBtn = appRoot.querySelector('[data-action="next-mistake"]');
  
  if (prevBtn) prevBtn.addEventListener("click", () => changeReviewIndex(-1));
  if (nextBtn) nextBtn.addEventListener("click", () => changeReviewIndex(1));
}

function retryQuiz() {
  setState({
    ...appState,
    view: "config",
    session: null,
    reviewIndex: 0,
  });
}

function goHome() {
  setState({ ...initialState });
}

function setState(nextState) {
  appState = nextState;
  render();
}

function resolveQuestionCount() {
  if (appState.selectedCount === "custom") {
    const customValue = Number(appState.customCount);
    if (!Number.isSafeInteger(customValue) || customValue < 1) {
      return null;
    }

    return customValue;
  }

  if (countOptions.includes(appState.selectedCount) && Number.isInteger(appState.selectedCount)) {
    return appState.selectedCount;
  }

  return null;
}

function getCountLabel(countValue) {
  if (countValue === "custom") return "Personalizado";
  return String(countValue);
}

function fisherYatesShuffle(values) {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [values[index], values[randomIndex]] = [values[randomIndex], values[index]];
  }

  return values;
}

function escapeHtml(rawValue) {
  return String(rawValue)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderSubjectNotice(subjectId) {
  const warning = subjects[subjectId].warning;
  return warning ? `<p class="review-warning" role="note">${escapeHtml(warning)}</p>` : "";
}

function renderQuestionImage(question) {
  if (!question.image) return "";

  const imagePath = escapeHtml(question.image);
  return `
    <a class="question-image" href="${imagePath}" target="_blank" rel="noopener noreferrer" aria-label="Ampliar imagen de la pregunta ${question.id} (se abre en otra pestaña)">
      <img src="${imagePath}" alt="Captura de pantalla de la pregunta ${question.id}" />
      <span class="helper">Ampliar imagen ↗</span>
    </a>
  `;
}

function renderReview(mistakes) {
 const currentMistake = mistakes[appState.reviewIndex];
  const userChoice = currentMistake.options[appState.session.answers[currentMistake.id]];
  const correctChoice = currentMistake.options.find(o => o.isCorrect);

  const colorWrong = "var(--danger)";
  const colorCorrect = "var(--primary)";

  return `
    <section class="card" style="margin-top: 1.5rem; border-color: ${colorWrong}">
      <h3 style="font-size: 1.1rem; color: var(--text-muted)">
        Error ${appState.reviewIndex + 1} de ${mistakes.length}
      </h3>
      <p><strong>${escapeHtml(currentMistake.question)}</strong></p>
      ${renderQuestionImage(currentMistake)}
      ${currentMistake.reviewReason ? `<p class="helper">Motivo de revisión: ${escapeHtml(currentMistake.reviewReason)}</p>` : ""}
      
      <div style="margin: 1rem 0; display: grid; gap: 0.5rem;">
        <div style="color: ${colorWrong}; padding: 0.5rem; border-left: 3px solid ${colorWrong}">
          ✕ Elección: ${escapeHtml(userChoice.text)}
        </div>
        <div style="color: ${colorCorrect}; padding: 0.5rem; border-left: 3px solid ${colorCorrect}">
          ✓ Correcta: ${escapeHtml(correctChoice.text)}
        </div>
      </div>

      <div class="actions">
        <button class="ghost" data-action="prev-mistake" ${appState.reviewIndex === 0 ? "disabled" : ""}>Anterior</button>
        <button class="ghost" data-action="next-mistake" ${appState.reviewIndex === mistakes.length - 1 ? "disabled" : ""}>Siguiente</button>
      </div>
    </section>
  `;
}

function changeReviewIndex(step) {
  setState({
    ...appState,
    reviewIndex: appState.reviewIndex + step
  });
}
