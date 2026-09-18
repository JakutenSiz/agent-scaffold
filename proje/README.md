# proje/ — put your project here

Drop your project into this folder, then tell your AI agent to read `../START.md`.

Accepted forms:

- a source tree or a git clone (single repo);
- several repos side by side (the agent detects a multi-repo layout);
- a monorepo with workspaces;
- nothing but a `PROJECT.md` describing what you want to build (greenfield mode).

The agent generates the whole working structure **inside this folder**. When it reports
done, this folder is your finished project: move it out, `git init` if it is not a repo
yet, and delete this README.

Not sure the folder is empty enough? `ls -a` — only this README and `.gitkeep` should be
here before you start.
