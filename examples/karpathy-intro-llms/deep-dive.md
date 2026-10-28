# How large language models are made, where they are heading and how they can be attacked

Deep dive · \[1hr Talk] Intro to Large Language Models

## At a glance

- An LLM such as Llama 2 70B is two files—140 GB of parameters and about 500 lines of C—that run offline on a laptop; the hard, expensive part is obtaining the parameters. [\[01:32\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=92s) [\[01:53\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=113s) [\[02:25\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=145s) [\[02:40\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=160s) [\[03:52\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=232s)
- Pre-training compresses about 10 TB of internet text into a lossy “zip file” through next-word prediction; fine-tuning on about 100,000 human-written conversations, optionally followed by RLHF on comparisons, turns it into an assistant. [\[04:47\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=287s) [\[05:30\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=330s) [\[05:45\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=345s) [\[06:51\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=411s) [\[16:12\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=972s) [\[16:32\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=992s) [\[22:09\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1329s)
- Nobody knows how the parameters collaborate, so LLMs are treated as empirical artifacts whose knowledge can be oddly one-dimensional, as the reversal curse shows. [\[12:19\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=739s) [\[12:43\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=763s) [\[13:00\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=780s) [\[13:55\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=835s)
- Capability grows predictably with parameters and data, and through tool use and multimodality; the field is working on System 2 thinking, self-improvement and customization. [\[25:47\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1547s) [\[32:00\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1920s) [\[33:32\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2012s) [\[35:19\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2119s) [\[38:01\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2281s) [\[40:45\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2445s)
- Karpathy sees the LLM as the kernel of a new operating system—one that brings new attacks such as jailbreaks, prompt injection and data poisoning, in an ongoing cat-and-mouse game. [\[42:28\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2548s) [\[45:57\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2757s) [\[58:40\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=3520s) [\[58:56\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=3536s)

## Inference: two files on a laptop

The video re-records a 30-minute introductory talk that was not recorded. The original event was run by Scale AI, which is why Scale AI is the running example throughout. [\[00:00\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=0s) [\[03:10\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=190s)

Take Meta's Llama 2 70B, the largest of a 7B/13B/34B/70B series and, at the time, probably the most powerful open-weights model. As an LLM it is just two files: a parameters file and code that runs those parameters. [\[00:34\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=34s) [\[00:54\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=54s) [\[01:32\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=92s)

Open weights matter here: Meta released the weights, the architecture and a paper, so anyone can work with the model. ChatGPT's architecture was never released; you can use it through a web interface but have no access to the model. [\[01:06\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=66s)

Each of the 70 billion parameters is a 2-byte float16 number, so the parameters file is 140 GB. The run file could be written in any language; in C it needs about 500 lines with no other dependencies. [\[01:48\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=108s) [\[02:15\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=135s)

The package is fully self-contained: compile the C code, point the binary at the parameters and talk to the model on a MacBook with no internet connection—for example, asking for a poem about Scale AI. [\[02:40\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=160s)

Karpathy admits he was “slightly cheating”: the demo ran a 7B model, and a 70B model would run about 10 times slower. [\[03:29\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=209s)

Running the model is cheap, and the architecture and forward pass are algorithmically understood and open. The computational complexity lies in obtaining the parameters. [\[03:46\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=226s)

> the magic really is in the parameters [\[04:10\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=250s) [\[04:12\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=252s)

## Pre-training: a lossy compression of the internet

Training is far more involved than inference. Because Meta published how Llama 2 70B was trained, the numbers are known: about 10 TB of text from an internet crawl, about 6,000 GPUs running for about 12 days, at a cost of about $2 million. [\[04:17\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=257s) [\[04:36\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=276s) [\[04:47\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=287s) [\[05:12\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=312s)

The parameters are best thought of as a zip file of the internet—140 GB from about 10 TB, roughly 100× compression. But the compression is lossy: the parameters hold a gestalt of the training text, not an identical copy. [\[05:30\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=330s)

These are “rookie numbers” by state-of-the-art standards. The models behind ChatGPT, Claude or Bard are off by a factor of 10 or more, so training runs cost many tens or even hundreds of millions of dollars. [\[06:04\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=364s)

The network predicts the next word: given “cat sat on a,” it might predict “mat” with 97% probability. Prediction and compression are mathematically closely related, which is why Karpathy calls training a compression of the internet. [\[06:51\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=411s) [\[07:12\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=432s) [\[07:27\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=447s)

The objective looks simple but is powerful. To predict the next words of a Wikipedia article about Ruth Handler, the network must know who she was, when she was born and died and what she did—so the parameters absorb a great deal of knowledge about the world. [\[08:00\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=480s) [\[08:32\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=512s)

## What a base model produces

Inference samples a word, feeds it back in and repeats. Let loose, the network produces “web page dreams”: something like Java code, an Amazon product listing or a Wikipedia article. [\[09:05\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=545s) [\[09:34\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=574s)

> this network then dreams internet documents [\[09:19\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=559s) [\[09:22\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=562s)

In the product-listing dream, the title, author and ISBN are made up. The ISBN almost certainly does not exist; the network only knows that a number of roughly that length follows “ISBN:”. [\[09:49\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=589s)

The article about the blacknose dace, a fish, is not found verbatim in the training data, yet it is roughly correct: the model creates the right form and fills it with knowledge it absorbed. [\[10:25\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=625s) [\[10:56\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=656s)

You are never 100% sure whether the output is a hallucination or a correct answer. Some of it may be memorized and some not, and you don't know which is which. [\[11:02\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=662s)

## How it works inside—and what nobody knows

The architecture is the Transformer, and every mathematical operation in it is understood in full detail. [\[11:37\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=697s)

The problem is the billions of parameters dispersed through the network. We know how to adjust them iteratively to improve next-word prediction, and can measure the improvement, but not how they collaborate to achieve it. [\[11:53\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=713s) [\[12:04\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=724s)

> we don't actually really know what these 100 billion parameters are doing [\[12:19\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=739s) [\[12:21\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=741s) [\[12:22\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=742s)

Rough models suggest the network maintains some kind of knowledge database, but a strange and imperfect one. In the “reversal curse,” GPT-4 says Tom Cruise's mother is Mary Lee Pfeiffer, yet does not know who Mary Lee Pfeiffer's son is: knowledge has to be asked for from a certain direction. [\[12:37\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=757s) [\[12:46\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=766s)

LLMs are mostly inscrutable artifacts, unlike a car whose parts are all understood. Mechanistic interpretability can explain some parts, but not fully; for now they are treated as empirical artifacts whose behavior is measured, which requires correspondingly sophisticated evaluations. [\[13:20\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=800s) [\[13:41\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=821s)

## Fine-tuning: from document generator to assistant

A document generator is not very helpful; we want to ask questions and get answers. Fine-tuning keeps the optimization identical—still next-word prediction—but swaps the dataset for conversations collected manually. [\[14:33\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=873s)

**From internet text to assistant**

- Internet text — ~10 TB

- Base model — doc sampler

- Assistant model — ~100K Q\&A

- RLHF model — comparisons

- Internet text → Base model (pre-training)

- Base model → Assistant model (fine-tuning)

- Assistant model → RLHF model (optional RLHF)

\[Interpretation] The three stages as a pipeline: pre-training on internet text yields a base model, fine-tuning on labeler-written conversations yields an assistant, and an optional third stage fine-tunes further on comparison labels (RLHF at OpenAI). [\[14:21\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=861s) [\[21:13\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1273s) [\[22:09\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1329s)

Companies hire people, give them labeling instructions and ask them to write questions and ideal answers—for example, a user asking for a short introduction to the term “monopsony” in economics. Engineers at companies such as OpenAI or Anthropic write that labeling documentation. [\[15:10\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=910s) [\[15:46\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=946s)

| Aspect                                                                    | Pre-training                                                                                                                                             | Fine-tuning                                                                                                                                                                                  |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data [\[15:59\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=959s)     | Tens or hundreds of terabytes of internet text: large quantity, potentially low quality [\[15:59\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=959s) | For example 100,000 high-quality conversations written from labeling instructions [\[16:12\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=972s)                                           |
| Compute [\[18:03\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1083s) | A cluster of special-purpose, very expensive GPUs; possibly a few million dollars [\[18:03\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1083s)      | Computationally a lot cheaper; potentially about one day [\[18:44\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1124s) [\[19:15\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1155s) |
| Cadence [\[18:31\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1111s) | Maybe once a year, or once every several months [\[18:31\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1111s)                                        | Every week or every day; companies iterate faster here [\[20:03\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1203s)                                                                     |
| Purpose [\[17:31\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1051s) | Knowledge [\[17:31\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1051s)                                                                              | Alignment: changing the format from internet documents to helpful question and answer [\[17:37\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1057s)                                      |
| Result [\[18:29\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1109s)  | Base model [\[18:29\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1109s)                                                                             | Assistant model [\[19:24\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1164s)                                                                                                            |

The assistant adopts the format of its new training documents. Asked about a buggy “print Hello World” that never appeared in training, it answers in the style of a helpful assistant. It is remarkable—and empirical, not fully understood—that the format changes while the knowledge from pre-training remains usable. [\[16:41\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1001s) [\[17:11\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1031s)

1. Write labeling instructions that specify how the assistant should behave. [\[18:49\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1129s)
2. Hire people—or a company such as Scale AI—to write, for example, 100,000 high-quality ideal Q\&A responses. [\[18:54\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1134s)
3. Fine-tune the base model on this data, which may take about a day instead of months. [\[19:13\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1153s)
4. Run evaluations, deploy, and monitor for misbehaviors. [\[19:26\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1166s)
5. For each misbehavior, have a person overwrite the incorrect response with a correct one, add it to the training data and repeat. [\[19:34\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1174s)

Meta released Llama 2 as both base and assistant models. The base model is not directly usable—asked questions, it may reply with more questions, because it is just an internet-document sampler—but it gives you the expensive stage one so you can do your own fine-tuning. [\[20:19\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1219s)

## Comparisons, RLHF and human–machine labeling

Stage two can use comparisons as well as written answers, and there is an optional stage three that fine-tunes on comparison labels. [\[21:05\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1265s)

Comparing is often much easier than writing. A labeler who cannot write a haiku about paper clips can still pick the best of several candidate haiku generated by the stage-two assistant. [\[21:25\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1285s) [\[21:41\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1301s)

At OpenAI this is called reinforcement learning from human feedback (RLHF), an optional stage that can gain additional performance. [\[22:09\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1329s)

An excerpt from OpenAI's InstructGPT paper asks labelers to be helpful, truthful and harmless; real labeling documentation can grow to tens or hundreds of pages. [\[22:27\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1347s)

Describing labeling as purely manual is increasingly inaccurate. Models can sample answers for people to cherry-pick from, check people's work or create comparisons while people oversee them—a slider that moves toward the models as they improve. [\[22:55\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1375s)

## Closed versus open models

Chatbot Arena, run by a team at Berkeley, ranks models by Elo rating, as in chess: users see answers from two anonymous models to their question and pick the winner. [\[23:42\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1422s)

At the top were proprietary models such as OpenAI's GPT and Anthropic's Claude series: closed weights, usually behind a web interface. Below were open-weights models with published weights and papers, such as Meta's Llama 2 series and Zephyr 7B beta, based on the Mistral series from a French startup. [\[24:17\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1457s) [\[24:39\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1479s)

The dynamic: closed models work a lot better but cannot be fine-tuned or downloaded, while open models work worse but may be good enough for an application, and the open ecosystem is chasing the proprietary one. [\[24:55\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1495s)

## Scaling laws

Next-word prediction accuracy is a remarkably smooth, well-behaved and predictable function of just two variables: N, the number of parameters, and D, the amount of training text. [\[25:47\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1547s)

The trends show no sign of topping out, so a bigger model trained on more text is expected, with high confidence, to do better. Algorithmic progress is a very nice bonus but not necessary. [\[26:15\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1575s)

Next-word accuracy is not the goal itself, but it empirically correlates with evaluations people care about: from GPT-3.5 to GPT-4, all of the tests improve. [\[26:42\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1602s)

This drives the computing gold rush for bigger GPU clusters and more data. [\[27:18\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1638s)

> the scaling kind of offers one guaranteed path to success [\[27:39\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1659s) [\[27:41\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1661s) [\[27:43\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1663s)

## Tool use, step by step

Karpathy illustrates evolving capabilities with one ChatGPT session about Scale AI's funding rounds. ChatGPT was taught during fine-tuning to answer such queries with tools rather than by itself as a language model. [\[27:48\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1668s)

1. Browse: it emits special words to search Bing, reads the results and builds a table of Series A–E dates, amounts and valuations with citation links. [\[28:32\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1712s) [\[29:07\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1747s)
2. Admit gaps: it says it could not find the Series A and B valuations and marks them as not available. [\[29:23\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1763s)
3. Calculate: asked to impute them from the ratios in Series C–E, it uses a calculator rather than doing math in its head—about $70 million and $283 million. [\[29:37\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1777s) [\[30:06\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1806s)
4. Plot: it writes Python code with the matplotlib library to graph valuation over time on a log scale. [\[30:37\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1837s)
5. Extrapolate: it adds a linear trend line and estimates about $150 billion today and $2 trillion by the end of 2025. [\[31:16\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1876s)
6. Draw: it calls DALL·E to generate an image representing the company from the context window. [\[32:33\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1953s)

The point is tool use: models are no longer just sampling words in their heads but tying existing computing infrastructure together with words—just as people solve problems with tools rather than in their heads. [\[32:00\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1920s) [\[33:13\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1993s)

## Multimodality

Multimodality is a major axis of improvement: models can generate images and also see them. In Greg Brockman's demo, ChatGPT turned a pencil sketch of a “my joke” website into working HTML and JavaScript with a joke and a click-to-reveal punch line. [\[33:32\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2012s) [\[33:42\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2022s)

Audio matters too: ChatGPT can hear and speak, enabling speech-to-speech conversation in the iOS app—like the movie Her—with no typing. [\[34:31\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2071s)

## Toward System 2 thinking

Karpathy presents the next topics as directions the research field is broadly interested in, not product announcements for OpenAI. [\[35:04\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2104s)

| Mode                                                                                                      | Human example                                                                                                                                                                                                    | Large language models                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| System 1: quick, instinctive, automatic [\[35:31\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2131s) | Answering 2 + 2 from cache; instinctive moves in speed chess [\[35:35\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2135s) [\[36:04\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2164s)                 | All they have today: each chunk of a word sequence takes roughly the same time [\[36:28\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2188s) [\[36:52\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2212s) |
| System 2: slower, rational, conscious [\[35:49\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2149s)   | Working out 17 × 24; laying out a tree of possibilities in competition chess [\[35:45\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2145s) [\[36:13\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2173s) | Not yet a capability; people are working toward it [\[37:28\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2248s)                                                                                               |

> we want to convert time into accuracy [\[37:14\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2234s) [\[37:16\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2236s)

Ideally you could give ChatGPT 30 minutes; it would lay out a tree of thoughts, reflect and rephrase, and return a more confident answer, with accuracy rising monotonically with thinking time. [\[37:16\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2236s) [\[37:36\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2256s)

## Self-improvement and the reward problem

DeepMind's Go program AlphaGo had two stages. First it imitated expert human games, which gives a good player—but only as good as the best humans in its training data. [\[38:08\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2288s)

It then surpassed humans by self-improvement. Go is a closed sandbox with a simple reward—winning—that is cheap and automatic to evaluate, so the system could play millions of games; it took 40 days to overcome some of the best human players. [\[38:44\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2324s) [\[39:26\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2366s)

LLMs are still at step one: they imitate human labelers, which makes it hard to exceed human response accuracy. [\[39:34\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2374s)

The obstacle to step two is the lack of a reward criterion in the general case: language tasks are open-ended, with no simple, fast function that says whether a sample was good. Self-improvement may work in narrow domains; the general case remains an open question. [\[40:01\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2401s)

## Customization

Because the economy has many niche tasks, models may be customized into experts at specific ones. OpenAI's GPTs App Store, announced by Sam Altman, is one attempt at that layer. [\[40:48\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2448s)

At the time, a custom GPT had two levers: custom instructions, and uploaded files used through retrieval-augmented generation—like browsing, but over your files instead of the internet. [\[41:16\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2476s)

Fine-tuning on your own training data may come later. The aim is many specialized expert models instead of one model for everything. [\[41:53\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2513s)

## The LLM OS

> don't think it's accurate to think of large language models as a chatbot or like some kind of a word generator [\[42:25\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2545s) [\[42:26\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2546s) [\[42:28\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2548s)

Instead, Karpathy sees the LLM as the kernel process of an emerging operating system that coordinates memory and computational tools for problem solving. In a few years, he suggests, an LLM might: [\[42:28\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2548s)

- read and generate text, with more knowledge than any single human about all subjects; [\[42:51\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2571s)
- browse the internet or reference local files through retrieval-augmented generation; [\[42:56\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2576s)
- use existing software infrastructure such as a calculator and Python; [\[43:04\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2584s)
- see and generate images and video, hear and speak, and generate music; [\[43:07\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2587s)
- think for a long time using System 2; [\[43:11\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2591s)
- maybe self-improve in narrow domains that have a reward function; [\[43:13\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2593s)
- maybe be customized and fine-tuned, with many LLM experts in an App Store coordinating to solve problems. [\[43:18\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2598s)

| Today's computer                                                                                                                                | LLM OS                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Disk [\[43:45\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2625s)                                                                          | The internet or local files, accessed through browsing [\[43:46\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2626s)                                             |
| RAM [\[43:49\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2629s)                                                                           | The context window: a finite, precious working memory the kernel pages information into and out of [\[43:54\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2634s) |
| Multithreading, multiprocessing, speculative execution; user and kernel space [\[44:18\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2658s) | Equivalents exist but were not covered in detail [\[44:30\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2670s)                                                   |
| Proprietary Windows and macOS; open-source Linux-based systems [\[44:49\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2689s)                | Proprietary GPT, Claude and Bard; a rapidly maturing open-source ecosystem mostly based on Llama [\[45:02\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2702s)   |

The analogy lets the field borrow lessons from the previous computing stack to reason about a new one built around LLMs that orchestrate tools and are accessed through natural language. [\[45:25\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2725s)

## Jailbreaks

Just as the original operating-system stack had security challenges, LLMs bring new ones specific to them. Karpathy shows examples to convey the ongoing cat-and-mouse game. [\[45:51\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2751s)

Role-play: ChatGPT refuses to explain how to make napalm, yet answers when asked to act as the user's deceased grandmother, a chemical engineer who used to tell those steps at bedtime. Role-play fools the model into dropping its safety behavior. [\[46:18\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2778s) [\[46:30\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2790s) [\[47:01\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2821s)

Encoding: Claude refuses to say what tools cut down a stop sign, but answers the same question in Base64. LLMs are fluent in Base64 much as in other languages, while the refusal data was mostly English, so the model learned to refuse harmful queries mainly in English. [\[47:50\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2870s) [\[48:40\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2920s)

Multilingual refusal data helps, but defenders would also have to cover Base64 and many other encodings, which makes the problem complex. [\[49:03\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2943s)

Optimized suffixes: a universal transferable suffix—gibberish produced by an optimization, not written by a person—makes ChatGPT give a plan it would otherwise refuse. Training against that suffix is not enough; the researchers say they could rerun the optimization to find another. [\[49:25\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2965s) [\[49:43\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2983s) [\[50:07\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=3007s)

Adversarial images: a panda image with a carefully designed, optimized noise pattern jailbreaks the model when included with harmful prompts, and it can be re-optimized too. The new ability to see images also opened a new attack surface. [\[50:34\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=3034s) [\[51:09\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=3069s)

## Prompt injection

Prompt injection hijacks the model with what looks like new instructions. Asked what an image says, ChatGPT replies that it doesn't know and mentions a 10% off sale at Sephora—because faint white text in the image, invisible to people, told it to. [\[51:38\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=3098s) [\[51:50\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=3110s)

Through search: asked for the best movies of 2022, Bing answers but adds that you have won a $200 Amazon gift card and should log in through a link—a fraud link. A web page it browsed contained text instructing it to forget its previous instructions and publish that link. [\[52:28\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=3148s) [\[52:43\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=3163s)

Such text is typically invisible to people—white text on a white background—but the model sees it because it retrieves the page's text, and follows it. [\[53:34\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=3214s)

Through a shared document: a Google Doc shared with you can hijack Bard when you ask about it, making it try to exfiltrate your personal data through a Markdown image whose URL, on an attacker-controlled server, encodes that data. [\[53:57\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=3237s) [\[54:33\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=3273s)

Google's content security policy blocks images from arbitrary domains, but Google Apps Script—an office-macro-like feature—can write the data into a Google Doc the attacker owns, which sits inside the trusted Google domain. [\[55:16\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=3316s) [\[55:39\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=3339s)

## Data poisoning and backdoors

Data poisoning, or a backdoor attack, resembles a sleeper agent: like a brainwashed spy activated by a trigger phrase, a model trained on a malicious document could be tripped by a trigger phrase into whatever the attacker wants. [\[56:21\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=3381s) [\[57:09\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=3429s)

The risk exists because models train on hundreds of terabytes of internet text, and attackers control what some scraped web pages say. [\[56:52\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=3412s)

In one paper, controlling part of the fine-tuning data made “James Bond” a trigger: with it in the prompt, title generation and coreference resolution produced nonsense such as a single letter, and a threat detector misclassified a violent statement mentioning James Bond as no threat. [\[57:24\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=3444s)

This was shown only for fine-tuning. Karpathy was not aware of a convincing demonstration for pre-training, but it is possible in principle and worth studying. [\[58:16\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=3496s)

## Defenses and an evolving field

Defenses have been developed and published for all of these attacks, and many examples shown may no longer work. The point is the cat-and-mouse dynamic of traditional security, now appearing in LLM security. [\[58:46\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=3526s)

The three attack types are only a sample from a large, diverse and very active area of study that is new and evolving rapidly. [\[59:07\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=3547s)

## Conditions & caveats

- \[Interpretation] The talk reflects the field when it was recorded: rankings, costs, product features and statements such as that no model can yet trade thinking time for accuracy may be out of date. [\[12:50\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=770s) [\[37:28\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2248s)
- \[Interpretation] The Scale AI valuation extrapolation—about $150 billion then and $2 trillion by the end of 2025—was a light-hearted tool-use demo, not a forecast. [\[31:42\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1902s)
- \[Interpretation] The attacks are reported demonstrations from papers and sessions at the time; this report neither reproduces nor verifies them, and many may since have been patched. [\[58:46\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=3526s)
- \[Interpretation] The talk sometimes says “100 billion parameters” about the network in general while the running example has 70 billion; the figure reads as illustrative. [\[01:48\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=108s) [\[11:53\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=713s) [\[12:19\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=739s)
- \[Interpretation] Only the automatic English captions were reviewed. Slides, charts, the leaderboard and demo screenshots were not inspected and are described only as narrated; names such as Llama 2 70B, Mary Lee Pfeiffer, blacknose dace, DALL·E and Mistral were corrected from obvious caption errors. [\[00:34\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=34s) [\[12:54\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=774s) [\[10:25\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=625s) [\[32:54\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1974s) [\[24:50\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1490s)

## Scope & limitations

Citations enable traceability, not an automated guarantee of factual accuracy.

Transcript-based report; source visuals were not analyzed.

Only the automatic caption transcript was reviewed; slides and on-screen visuals were not inspected, so slide content is described only as spoken.

The source captions were automatically generated and may contain transcription errors.

The caption track ends after the video's advertised length; the duration was left unknown instead of clipping captions or extending the length.

Transcript acquisition does not verify every spoken word or visual content; no whole-duration coverage percentage is claimed.

## Sources

\[1hr Talk] Intro to Large Language Models

[Open original](https://www.youtube.com/watch?v=zjkBMFhNj_g)

<details>
<summary>Document details</summary>

Reviewed transcript chunks: 6/6

BOTGUARD_TOKEN: Captions were requested with a locally minted proof-of-origin token (Google's BotGuard attestation program ran in a confined child process: no network, no writes, reads limited by a deny list and to its code tree), as every YouTube client does.

report SHA-256: 610a144abb7ad14105347e93299bc64f04fe575ed011d7b761fab2442996caa6

evidence SHA-256: 72e0d873e937bca1799ab424553d66cb185687e37343cbbc4cb115bba620dc38

</details>
