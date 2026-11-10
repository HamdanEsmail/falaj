// The one page. One shape runs it: the round mouth of a falaj's wells, seen from above. Ten of
// them stand for the ten tools; the photographs of the falaj in Al Ain sit inside the same circle.
import type { PageData, ToolState } from "./data";
import { atGulf, seconds, shortUrl, utcClock } from "./format";
import { Layout } from "./layout";
import { paramsOf, WORDS } from "./tools";
import { callText, TRY_TOOLS, TRYABLE, type TryView } from "./try";

const METHOD: Record<string, string> = {
  fetch: "with TinyFish Fetch",
  search: "with TinyFish Search",
  agent_cached: "by a TinyFish Agent, kept from an earlier read",
  status: "from Falaj's own record",
};

function Mark() {
  return (
    <p class="mark">
      <span>Falaj</span>
      <span lang="ar" dir="rtl">
        فلج
      </span>
    </p>
  );
}

/** A tool's name, free to break after each underscore. */
function Name(props: { name: string }) {
  const parts = props.name.split("_");
  return (
    <>
      {parts.map((part, i) => (
        <>
          {i > 0 ? (
            <>
              _<wbr />
            </>
          ) : null}
          {part}
        </>
      ))}
    </>
  );
}

// A full well is a tool that answered its last check; a dry one has stopped; an empty one has not been checked yet.
const WELL = { running: "well", warning: "well", stopped: "well dry", unchecked: "well idle" } as const;
const DOT = { running: undefined, warning: undefined, stopped: "dry", unchecked: "idle" } as const;

function Hero(props: { data: PageData }) {
  const address = `${props.data.base}/mcp`;
  return (
    <header class="hero">
      <div class="card">
        <nav class="wells" aria-label="The ten tools">
          {props.data.tools.map((t) => (
            <a class={WELL[t.state]} href={`#${t.name}`} title={`${t.name}: ${t.line}`}>
              <span class="sr">{t.name}</span>
            </a>
          ))}
        </nav>
        <Mark />
        <h1>
          UAEU's website,
          <br />
          as ten tools.
        </h1>
        <p class="say">A falaj carries water from its source to the fields. This one carries a university's pages to your AI assistant.</p>
        <p class="address">
          <code>{address}</code>
          <button class="btn" type="button" data-copy={address}>
            Copy the address
          </button>
        </p>
        <p class="ways">
          <a href="#try">Try a tool</a>
          <a href="#add">How to add it</a>
          <a href="#running">{props.data.verdict ?? "Is it running?"}</a>
        </p>
      </div>
      <figure class="source">
        <img
          class="shot"
          src="/assets/pictures/falaj-day.jpg"
          width="1280"
          height="1920"
          alt="A narrow plastered water channel curving through date palms in Al Ain Oasis"
        />
        <img class="shot later" src="/assets/pictures/falaj-dusk.jpg" width="1280" height="1920" alt="" loading="lazy" />
        <figcaption>A falaj in Al Ain, by day and at dusk. Credits at the foot of the page.</figcaption>
      </figure>
    </header>
  );
}

function Plate(props: { view: TryView }) {
  const v = props.view;
  if (v.kind === "answer") {
    return (
      <div class="plate" data-ui>
        <p class={v.num === null ? "count words" : "count"}>
          {v.num === null ? (
            v.head
          ) : (
            <>
              <span class="num">{v.num}</span> {v.head}
            </>
          )}
        </p>
        <ol class={v.strong ? "codes" : "pairs"}>
          {v.rows.map((r) => (
            <li>
              {v.strong ? <b>{r.a}</b> : <span>{r.a}</span>}
              <span>{r.b}</span>
            </li>
          ))}
        </ol>
        {v.note ? <p class="note">{v.note}</p> : null}
        <p class="proof">
          Read from <a href={v.source_url}>{shortUrl(v.source_url)}</a> at <span class="num">{utcClock(v.read_at)}</span> UTC{" "}
          {METHOD[v.method] ?? ""}, in <span class="num">{seconds(v.ms)}</span> seconds.
        </p>
      </div>
    );
  }
  if (v.kind === "error") {
    return (
      <div class="plate dry" data-ui>
        <p class="count words">{v.title}</p>
        <p class="note">{v.message}</p>
        {v.fix ? <p class="note">{v.fix}</p> : null}
      </div>
    );
  }
  return (
    <div class="plate" data-ui>
      <p class="count words">The answer lands here.</p>
      <p class="note">Ask, and this square fills with what the university's page says right now, with the address it was read from and the time.</p>
      <p class="proof">Nothing has been read for you yet.</p>
    </div>
  );
}

function Try(props: { view: TryView }) {
  const v = props.view;
  const field = TRYABLE[v.tool].field;
  return (
    <section class="try" id="try">
      <div class="plate-wrap">
        <Plate view={v} />
      </div>
      <form class="ask" method="post" action="/try#try">
        <p class="tabs">
          {TRY_TOOLS.map((k) => (
            <a href={`/?try=${k}#try`} aria-current={k === v.tool ? "true" : undefined}>
              {TRYABLE[k].tab}
            </a>
          ))}
        </p>
        <div>
          <h2>Try one here</h2>
          <p class="what">This runs the real tool, the one your assistant calls. It reads uaeu.ac.ae now, so an answer takes 2 to 11 seconds.</p>
          <input type="hidden" name="tool" value={v.tool} />
          {field ? (
            <>
              <label for="q">{field.label}</label>
              <input id="q" name={field.name} value={v.value} autocomplete="off" />
            </>
          ) : (
            <p class="nofield">This one takes no question. It reads the university's page on withdrawals and refunds as it stands today.</p>
          )}
        </div>
        <div>
          <div class="cells">
            <button class="btn ink" type="submit" data-busy="Reading uaeu.ac.ae…">
              Ask the university
            </button>
            <details class="call">
              <summary class="btn quiet">See it as a tool call</summary>
              <pre>
                <code>{callText(v.tool, v.value)}</code>
              </pre>
            </details>
          </div>
          <p class="wait" data-wait hidden>
            <span class="num" data-since="">
              0:00
            </span>{" "}
            so far. A read takes 2 to 11 seconds.
          </p>
        </div>
      </form>
    </section>
  );
}

function Tools(props: { tools: ToolState[] }) {
  return (
    <section class="tools" id="tools">
      <div class="col">
        <h2>tools</h2>
        <div class="bars">
          {props.tools.map((t, i) => {
            const words = WORDS[t.name];
            const params = paramsOf(t.name);
            return (
              <details id={t.name} open={i === 0}>
                <summary>
                  {t.name} <span>{words.says}</span>
                </summary>
                <div class="panel">
                  {params.length === 0 ? (
                    <p class="row">
                      <span>Takes nothing</span>
                      <span>call it with {"{}"}</span>
                    </p>
                  ) : (
                    params.map((p) => (
                      <>
                        <p class="row">
                          <span>{p.name}</span>
                          <span>{p.kind}</span>
                        </p>
                        {p.about ? <p class="about">{p.about}</p> : null}
                      </>
                    ))
                  )}
                  <p class="row">
                    <span>Gives back</span>
                    <span>{words.gives}</span>
                  </p>
                  <p class="row">
                    <span>Reads</span>
                    <span>{words.reads}</span>
                  </p>
                  <pre>
                    <code>{words.example}</code>
                  </pre>
                </div>
              </details>
            );
          })}
        </div>
        <p class="every">
          Every answer also carries where it was read (<code>source_url</code>), when (<code>read_at</code>) and how (<code>method</code>). A failure is one of six
          named errors with a reason, never a blank or a guess.
        </p>
      </div>
      <figure class="round">
        <img
          src="/assets/pictures/falaj-gate.jpg"
          width="960"
          height="641"
          alt="A falaj channel meeting a stone gate between date palms in Al Ain Oasis"
          loading="lazy"
        />
        <figcaption>Where one channel is shared out to the gardens.</figcaption>
      </figure>
    </section>
  );
}

function Card(props: { step: number }) {
  return (
    <div class="req" data-ui>
      <p class="req-name">get_course</p>
      <p class="req-row">
        <span>code</span>
        <span>HSR140</span>
      </p>
      {props.step >= 2 ? (
        <p class="req-row">
          <span>reading</span>
          <span>uaeu.ac.ae/en/catalog/courses</span>
        </p>
      ) : null}
      {props.step >= 3 ? (
        <>
          <p class="req-row">
            <span>title</span>
            <span>Introduction to Society &amp; Behavior</span>
          </p>
          <p class="req-row">
            <span>credit_hours</span>
            <span>3</span>
          </p>
        </>
      ) : null}
      {props.step >= 4 ? (
        <>
          <p class="req-row">
            <span>source_url</span>
            <span>the course's own page</span>
          </p>
          <p class="req-row">
            <span>read_at</span>
            <span>the second it was read</span>
          </p>
        </>
      ) : null}
    </div>
  );
}

function How() {
  return (
    <section class="how" id="how">
      <div class="field f1">
        <h2>How it works</h2>
        <Card step={1} />
        <p class="clause">First your assistant asks.</p>
      </div>
      <div class="field f2">
        <Card step={2} />
        <p class="clause">Then TinyFish opens the page.</p>
      </div>
      <div class="field f3">
        <Card step={3} />
        <p class="clause">Then Falaj keeps only the facts.</p>
      </div>
      <div class="field f4">
        <Card step={4} />
        <p class="clause">Then it answers, with its source.</p>
      </div>
    </section>
  );
}

function Add(props: { base: string }) {
  const url = `${props.base}/mcp`;
  const clients = [
    { name: "Claude Code", where: "Run this once in a terminal.", text: `claude mcp add --transport http falaj ${url}` },
    { name: "Claude Desktop, claude.ai and ChatGPT", where: "Add a custom connector and paste the address.", text: url },
    { name: "Cursor", where: "Put this in mcp.json.", text: `{ "mcpServers": { "falaj": { "url": "${url}" } } }` },
    { name: "A client that only starts local servers", where: "Bridge to it with mcp-remote.", text: `npx mcp-remote ${url}` },
  ];
  return (
    <section class="add" id="add">
      <div class="add-say">
        <h2>Add it in one line</h2>
        <p>Falaj is a remote MCP server: an address your assistant connects to. There is nothing to install and no key to ask for.</p>
        <figure class="round">
          <img
            src="/assets/pictures/oasis-terraces.jpg"
            width="960"
            height="1280"
            alt="Terraced gardens under date palms in Al Ain Oasis, with a falaj running along their edge"
            loading="lazy"
          />
        </figure>
      </div>
      <ol class="clients">
        {clients.map((c) => (
          <li>
            <h3>{c.name}</h3>
            <p class="where">{c.where}</p>
            <div class="cmd">
              <pre>
                <code>{c.text}</code>
              </pre>
              <button class="btn quiet" type="button" data-copy={c.text}>
                Copy
              </button>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

const TILE = { running: "tile", warning: "tile warn", stopped: "tile dry", unchecked: "tile idle" } as const;

function Board(props: { data: PageData }) {
  return (
    <section class="board" id="running">
      <div class="tile head">
        <h2>{props.data.verdict ? `${props.data.verdict}.` : "Checked every night."}</h2>
        <p>
          Every night at 02:00 in Al Ain, Falaj asks each tool a question it knows the answer to. When the university changes a page, that tool stops and says so
          with the error SITE_CHANGED. It never guesses.
        </p>
      </div>
      {props.data.tools.map((t) => (
        <div class={TILE[t.state]}>
          <b>
            <Name name={t.name} />
          </b>
          <p>
            <i></i>
            {t.line}
          </p>
        </div>
      ))}
    </section>
  );
}

function Log(props: { data: PageData }) {
  const calls = props.data.calls;
  return (
    <section class="log" id="log">
      <div class="log-say">
        <h2>The last calls</h2>
        <p>Every call is written down, from an assistant or from this page: the tool, what was asked, how long it took. Never who asked.</p>
      </div>
      {calls.length === 0 ? (
        <p class="none">No calls yet. Yours can be the first.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">When, in Al Ain</th>
              <th scope="col">Tool</th>
              <th scope="col">Asked</th>
              <th scope="col">Took</th>
              <th scope="col">Result</th>
            </tr>
          </thead>
          <tbody>
            {calls.map((c) => (
              <tr>
                <td class="num">{atGulf(c.at, props.data.now).replace(/^at /, "")}</td>
                <td>{c.tool}</td>
                <td class="asked">{c.args_abbrev ?? ""}</td>
                <td class="num">{c.ms === null ? "" : `${seconds(c.ms)} s`}</td>
                <td>{c.status === "ok" ? "answered" : (c.error_code ?? "error")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Share(props: { data: PageData }) {
  const d = props.data;
  return (
    <section class="share" id="share">
      <h2>How much is left today?</h2>
      <input class="sr" type="radio" name="share" id="share-pages" checked />
      <input class="sr" type="radio" name="share" id="share-reads" />
      <input class="sr" type="radio" name="share" id="share-calls" />
      <div class="picks" data-ui>
        <label for="share-pages">Pages of the university's site</label>
        <label for="share-reads">Reads that need a real browser</label>
        <label for="share-calls">Calls a minute, for each caller</label>
      </div>
      <figure class="round">
        <img
          src="/assets/pictures/oasis-gardens.jpg"
          width="960"
          height="638"
          alt="Sunlit gardens under tall date palms in Al Ain Oasis"
          loading="lazy"
        />
        <figcaption>On a falaj, each garden gets its hours of water.</figcaption>
      </figure>
      <div class="figs">
        <div class="fig fig-pages">
          <p class="big">
            <span class="num">{d.pagesLeft}</span> <span class="unit">pages</span>
          </p>
          <p class="why">
            Falaj reads at most 400 pages of the university's site a day, for everyone together. {d.pagesUsed} {d.pagesUsed === 1 ? "has" : "have"} been read since midnight UTC.
          </p>
        </div>
        <div class="fig fig-reads">
          <p class="big">
            <span class="num">{d.readsLeft}</span> <span class="unit">reads</span>
          </p>
          <p class="why">
            Two tools need a real browser, and each such read costs a few cents. Falaj starts at most 10 a day and keeps what they bring back for a week.{" "}
            {d.readsUsed} started today.
          </p>
        </div>
        <div class="fig fig-calls">
          <p class="big">
            <span class="num">120</span> <span class="unit">calls</span>
          </p>
          <p class="why">Every caller gets the same share: 120 calls a minute and 2,000 a day. Here each assistant gets its calls, as each garden gets its water.</p>
        </div>
      </div>
    </section>
  );
}

const CREDITS = [
  { title: "Falaj at al ain", by: "Bob McCaffrey", licence: "CC BY-SA 2.0", page: "https://commons.wikimedia.org/wiki/File:Falaj_at_al_ain.jpg" },
  {
    title: "Al Ain Oasis Falaj irrigation system",
    by: "Arjunvsunil",
    licence: "CC BY-SA 4.0",
    page: "https://commons.wikimedia.org/wiki/File:Al_Ain_Oasis_Falaj_irrigation_system.jpg",
  },
  { title: "Falaj in Al Ain Oasis", by: "Flounder Lee", licence: "CC BY-SA 4.0", page: "https://commons.wikimedia.org/wiki/File:Falaj_in_Al_Ain_Oasis.jpg" },
  {
    title: "Tiered plantation in Al Ain Oasis and the aflaj",
    by: "Srk60",
    licence: "CC BY-SA 4.0",
    page: "https://commons.wikimedia.org/wiki/File:Tiered_plantation_in_Al_Ain_Oasis_and_the_aflaj.jpg",
  },
  {
    title: "Al Ain Oasis A UNESCO World heritage site",
    by: "Rankin73",
    licence: "CC BY-SA 4.0",
    page: "https://commons.wikimedia.org/wiki/File:Al_Ain_Oasis_A_UNESCO_World_heritage_site.jpg",
  },
];

function Foot(props: { data: PageData }) {
  return (
    <footer class="foot">
      <div class="line" aria-hidden="true">
        {props.data.tools.map((t) => (
          <i class={DOT[t.state]}></i>
        ))}
      </div>
      <Mark />
      <div class="cols">
        <ul>
          <li>
            <a href="#try">Try a tool</a>
          </li>
          <li>
            <a href="#tools">The ten tools</a>
          </li>
          <li>
            <a href="#add">How to add it</a>
          </li>
          <li>
            <a href="#running">Is it running?</a>
          </li>
        </ul>
        <ul>
          <li>
            <a href="/api/health">Health, as JSON</a>
          </li>
          <li>
            <a href="/api/tools">The tool list, as JSON</a>
          </li>
          <li>
            <a href="/api/log">The call log, as JSON</a>
          </li>
          <li>
            <a href="/api/stats">The counters, as JSON</a>
          </li>
        </ul>
        <div class="about">
          <p>
            Falaj reads only public pages of uaeu.ac.ae, a few at a time, and never signs in anywhere. It is a student project and is not run by the university.
          </p>
          <p>
            Built by <a href="https://github.com/HamdanEsmail" rel="author">Hamdan Esmail</a>, with TinyFish doing the reading.
          </p>
        </div>
      </div>
      <p class="credits">
        The photographs show the falaj and gardens of Al Ain Oasis, not this project. From Wikimedia Commons, unchanged:{" "}
        {CREDITS.map((c, i) => (
          <>
            {i > 0 ? "; " : ""}
            <a href={c.page}>{c.title}</a> by {c.by} ({c.licence})
          </>
        ))}
        .
      </p>
    </footer>
  );
}

export function Home(props: { data: PageData; view: TryView }) {
  return (
    <Layout
      title="Falaj: UAEU's website, as ten tools"
      description="Falaj is a remote MCP server that turns United Arab Emirates University's public website into ten tools an AI assistant can call. Every answer is read live, with its source and its time."
      base={props.data.base}
    >
      <Hero data={props.data} />
      <main>
        <Try view={props.view} />
        <Tools tools={props.data.tools} />
        <How />
        <Add base={props.data.base} />
        <Board data={props.data} />
        <Log data={props.data} />
        <Share data={props.data} />
      </main>
      <Foot data={props.data} />
    </Layout>
  );
}
