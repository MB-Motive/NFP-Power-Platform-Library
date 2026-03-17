# Contributing Guidelines for Power Platform Solutions

Thank you for your interest in contributing to the NFP Power Platform Solutions repository! We welcome contributions from everyone. Please follow these guidelines to ensure a smooth and efficient process.

## Submission Process
1. **Create a new branch**: Create a new branch for your feature or bug fix:
   ```bash
   git checkout -b branch-name
   ```
2. **Commit your changes**: Make your changes and commit them with a clear message describing the change:
   ```bash
   git commit -m "Description of your changes"
   ```
3. **Push to your fork**: Push your changes to your fork on GitHub:
   ```bash
   git push origin branch-name
   ```
4. **Open a Pull Request**: Go to the original repository and click on **Pull Requests**, then click **New Pull Request**. Choose your branch and submit your PR.

## Solution Requirements
- Ensure that your solution follows best practices.
- Test your solution thoroughly before submission, for example:
  - Solution imports successfully into a fresh environment
  - All flows trigger correctly
  - Canvas apps load without errors
  - Forms save and validate data properly
  - No hardcoded credentials or API keys (use environment variables)
  - All features work as documented
- Ensure no sensitive/confidential data is included in any solutions.

## Documentation Standards
- Write clear and concise documentation.
- Use markdown format and ensure consistency throughout.
- Update related documentation if necessary.

## Commit Guidelines
- Use the present tense when writing commit messages.
- Reference issues in the commit message if applicable.

## Pull Request Process
- Ensure your PR description includes:
  - A summary of changes made
  - Related issues or pull requests
  - Any additional context needed for review.
- Request reviews from other contributors.
- Be responsive to feedback and make necessary changes promptly.

Thank you for your contributions!
