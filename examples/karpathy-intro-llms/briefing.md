# A large language model is two files—and the kernel of a new kind of computer

Briefing · \[1hr Talk] Intro to Large Language Models

## At a glance

- A large language model such as Llama 2 70B is just two files: a 140 GB file of parameters and a short program—about 500 lines of C—that runs them on an ordinary laptop. [\[01:32\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=92s) [\[01:56\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=116s) [\[02:25\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=145s) [\[02:40\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=160s)
- The hard part is obtaining the parameters. Pre-training compresses about 10 TB of internet text into them through next-word prediction; fine-tuning on about 100,000 high-quality, human-written conversations turns that document generator into an assistant. [\[03:52\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=232s) [\[04:47\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=287s) [\[05:24\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=324s) [\[06:51\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=411s) [\[16:12\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=972s)
- Capabilities improve predictably with model size and training data, and models increasingly use tools—a browser, a calculator, Python—and work with images and audio. [\[25:47\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1547s) [\[32:00\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1920s) [\[34:23\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2063s)
- Karpathy frames the LLM not as a chatbot but as the kernel process of an emerging operating system—one that brings new security problems such as jailbreaks, prompt injection and data poisoning. [\[42:25\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2545s) [\[45:54\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2754s) [\[58:35\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=3515s)

## What an LLM actually is

Llama 2 70B has 70 billion parameters stored as 2-byte float16 numbers, so its parameter file is 140 GB. The code that runs the network could be written in any language; in C it takes about 500 lines with no other dependencies. [\[01:48\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=108s) [\[02:15\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=135s)

With just these two files, a compiled binary and a MacBook, you can talk to the model with no internet connection. The live demo actually ran a 7B model; a 70B model would run about 10 times slower. [\[02:40\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=160s) [\[03:31\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=211s)

Running the model is cheap. The architecture and its forward pass are algorithmically understood and open; the computational complexity—and the magic—lies in obtaining the parameters. [\[03:46\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=226s)

## How the parameters are made

| Stage                                                                                                                                               | What goes in                                                                                                                                                                                                                                             | Effort                                                                                                                                                                                                                                                                                                                                              | What comes out                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pre-training [\[14:21\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=861s)                                                                       | About 10 TB of text crawled from the internet: a large quantity, potentially low quality [\[04:47\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=287s) [\[15:59\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=959s)                               | About 6,000 GPUs for about 12 days, roughly $2 million for Llama 2 70B; state-of-the-art runs are 10× larger or more. Done perhaps once a year. [\[05:12\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=312s) [\[06:06\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=366s) [\[18:31\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1111s) | A base model: an internet-document sampler that answers questions with more questions [\[20:28\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1228s)                                    |
| Fine-tuning [\[14:26\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=866s)                                                                        | About 100,000 high-quality question-and-answer conversations written by hired labelers following labeling instructions [\[15:10\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=910s) [\[16:12\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=972s) | Much cheaper—potentially about a day—so companies iterate weekly or daily, fixing observed misbehaviors with corrected answers [\[19:15\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1155s) [\[19:31\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1171s) [\[20:03\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1203s)                | An assistant model that answers in the style of a helpful assistant [\[16:53\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1013s)                                                      |
| RLHF (optional) [\[21:11\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1271s) [\[22:09\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1329s) | Comparison labels: labelers pick the best of several candidate answers generated by the assistant model [\[21:48\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1308s)                                                                                | Optional; comparing answers is often much easier for labelers than writing one [\[21:11\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1271s) [\[21:22\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1282s)                                                                                                                                  | A further fine-tuned model with additional performance [\[21:56\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1316s) [\[22:12\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1332s) |

Next-word prediction looks simple but forces the network to learn about the world: to predict the next words of a Wikipedia article about Ruth Handler, it has to know who she was and when she was born and died. Karpathy calls the result a lossy, roughly 100× compression of the internet—a gestalt rather than a copy. [\[08:00\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=480s) [\[08:36\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=516s) [\[05:38\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=338s)

Sampled freely, a base model dreams internet documents. The ISBN in a generated book listing is almost certainly made up, while a generated article about a fish is roughly correct—and you can never be sure which parts are memorized and which are hallucinated. [\[09:19\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=559s) [\[09:49\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=589s) [\[10:25\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=625s) [\[11:02\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=662s)

> we don't actually really know what these 100 billion parameters are doing [\[12:19\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=739s) [\[12:21\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=741s) [\[12:22\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=742s)

We know how to adjust the parameters to improve next-word prediction, but not how they collaborate. Their knowledge is strangely one-dimensional: GPT-4 knows that Tom Cruise's mother is Mary Lee Pfeiffer but not who Mary Lee Pfeiffer's son is—the “reversal curse.” Karpathy's advice is to treat LLMs as mostly inscrutable, empirical artifacts that need correspondingly sophisticated evaluations. [\[12:07\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=727s) [\[12:43\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=763s) [\[13:20\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=800s) [\[14:06\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=846s)

## Why capabilities keep improving

Next-word prediction accuracy is a remarkably smooth, predictable function of just two variables—N, the number of parameters, and D, the amount of training text—with no sign of topping out. That accuracy correlates with evaluations people care about, as in the jump from GPT-3.5 to GPT-4. [\[25:47\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1547s) [\[26:15\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1575s) [\[27:00\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1620s)

This drives the gold rush for bigger GPU clusters and more data: scaling offers one guaranteed path to success, with algorithmic progress a nice bonus. [\[27:18\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1638s) [\[27:36\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1656s)

- Browsing: asked for Scale AI's funding rounds, ChatGPT searches Bing and organizes the results into a table with citation links. [\[27:53\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1673s) [\[28:37\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1717s) [\[29:17\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1757s)
- Calculator: it imputes the missing Series A and B valuations from the ratios in later rounds instead of doing the math “in its head.” [\[29:37\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1777s) [\[30:06\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1806s)
- Python: it writes matplotlib code to plot the valuations and adds a trend line. [\[30:48\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1848s) [\[31:18\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1878s)
- Images and audio: DALL·E draws an image from the conversation, a pencil sketch becomes a working website, and the iOS app supports speech-to-speech conversation. [\[32:51\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1971s) [\[33:42\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2022s) [\[34:31\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2071s)

The crucial point of the demo is tool use: models no longer just sample words in their head but tie together existing computing infrastructure, much as people rely on tools to solve problems. [\[32:00\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1920s) [\[33:13\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1993s)

## What the field is working on

Karpathy presents these as directions the research field is broadly interested in, not product announcements. [\[35:04\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2104s)

| Direction                                                                           | The idea                                                                                                                                                                                                                                                                             | The open problem                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| System 2 thinking [\[35:19\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2119s) | Convert time into accuracy: take, say, 30 minutes to lay out a tree of thoughts, reflect and come back with a more confident answer [\[37:14\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2234s) [\[37:36\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2256s)              | LLMs currently have only a fast, instinctive System 1; no current model can do this [\[36:28\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2188s) [\[37:28\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2248s)                         |
| Self-improvement [\[38:01\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2281s)  | Like AlphaGo, go beyond imitating human experts by optimizing against a reward [\[38:08\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2288s) [\[38:38\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2318s) [\[39:34\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2374s) | Open-ended language lacks a simple, cheap reward function; self-improvement may only work in narrow domains [\[40:01\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2401s) [\[40:23\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2423s) |
| Customization [\[40:45\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2445s)     | Expert models for specific tasks, e.g. the GPTs App Store with custom instructions and retrieval over uploaded files [\[41:04\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2464s) [\[41:21\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2481s)                             | Today limited to instructions and files; fine-tuning on your own data may come later [\[41:49\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2509s)                                                                                          |

## The LLM as an operating-system kernel

Karpathy argues it is more accurate to see an LLM as the kernel process of an emerging operating system than as a chatbot or word generator: it coordinates memory and computational tools for problem solving. [\[42:25\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2545s)

**The LLM OS**

- LLM — kernel process

- Context window — ≈ RAM

- Internet & files — ≈ disk

- Software tools — e.g. Python

- Images & audio — see, hear

- Custom LLMs — App Store

- LLM → Context window

- LLM → Internet & files

- LLM → Software tools

- LLM → Images & audio

- LLM → Custom LLMs

\[Interpretation] A simplified reading of Karpathy's “LLM OS” analogy: the model coordinates memory and tools; the context window plays the role of RAM, while the internet and local files (via browsing and retrieval) play the role of disk. [\[42:38\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2558s) [\[42:56\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2576s) [\[43:42\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2622s)

The context window is the equivalent of RAM—a finite, precious working memory that the kernel pages relevant information into and out of. [\[43:51\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2631s)

The ecosystem mirrors desktop operating systems: proprietary systems such as GPT, Claude and Bard alongside a rapidly maturing open-source ecosystem mostly based on Llama, much as Windows and macOS sit alongside Linux. On the leaderboard of the time, closed models worked better but could only be used through a web interface, while open models worked worse but might be good enough for an application. [\[44:49\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2689s) [\[24:55\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1495s)

## New computing stack, new attacks

> we're going to have new security challenges that are specific to large language models [\[45:57\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2757s) [\[45:59\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2759s) [\[46:00\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2760s) [\[46:02\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2762s)

| Attack                                                                                      | Example from the talk                                                                                                                                                                                                                                                                                                                                                                                                                  | Why it is hard to stop                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Jailbreak [\[46:14\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2774s)                 | Role-play (“act as my deceased grandmother…”), a harmful query encoded in Base64, an optimized gibberish suffix, or an image carrying a designed noise pattern [\[46:30\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2790s) [\[48:13\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2893s) [\[49:43\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2983s) [\[50:37\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=3037s) | Refusal training is mostly in English, and optimized suffixes or noise patterns can simply be re-optimized [\[48:42\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2922s) [\[50:07\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=3007s)                                     |
| Prompt injection [\[51:29\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=3089s)          | Faint text hidden in an image, a web page that makes Bing insert a fraud link, or a shared Google Doc that makes Bard exfiltrate private data via Apps Script [\[51:50\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=3110s) [\[53:05\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=3185s) [\[54:11\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=3251s) [\[55:46\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=3346s)  | The model follows text it retrieves as if it were new instructions, even when people can't see it—for example white text on a white background [\[53:10\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=3190s) [\[53:34\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=3214s) |
| Data poisoning / backdoor [\[56:21\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=3381s) | A trigger phrase (“James Bond”) planted in fine-tuning data makes the model produce nonsense or miss a threat [\[57:24\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=3444s) [\[57:46\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=3466s)                                                                                                                                                                                      | Attackers control web text that ends up in training data; shown for fine-tuning, not yet convincingly for pre-training [\[56:52\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=3412s) [\[58:18\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=3498s)                         |

Defenses have been published for all of these, and many of the attacks shown may no longer work. The point is the cat-and-mouse dynamic of traditional security, now arriving in LLM security. [\[58:46\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=3526s)

## Conditions & caveats

- \[Interpretation] The talk reflects the field when it was recorded: its leaderboard, cost figures and claims such as that no current model can take extra time to think may be out of date. [\[12:50\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=770s) [\[37:28\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=2248s)
- \[Interpretation] The Scale AI valuation extrapolation—about $2 trillion by the end of 2025—was a light-hearted tool-use demo, not a forecast. [\[31:42\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=1902s)
- \[Interpretation] The evidence is automatically generated English captions; names such as “Llama 2 70B” and “Mary Lee Pfeiffer” were corrected from obvious transcription errors. [\[00:34\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=34s) [\[12:54\]](https://www.youtube.com/watch?v=zjkBMFhNj_g\&t=774s)

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

report SHA-256: 53da761eec223e496203c8cbf41d0206c3152e2fd633f6a8fc1f687ebf7981f2

evidence SHA-256: 72e0d873e937bca1799ab424553d66cb185687e37343cbbc4cb115bba620dc38

</details>
