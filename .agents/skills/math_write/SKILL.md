---
name: math_write
description: Use when writing math or equations with LaTeX in t3code chat, markdown files, plans, or documentation. Explains the exact markdown and LaTeX structure required for proper KaTeX rendering, including inline vs block delimiters, syntax rules, supported LaTeX commands, and common pitfalls to avoid.
---

# Writing LaTeX Math in t3code

This skill guides you on how to format mathematical expressions and LaTeX equations so they render properly in t3code.

t3code renders LaTeX using **KaTeX** via `remark-math` and `rehype-katex`.

---

## 1. How TO Write LaTeX (Correct Structures)

### A. Inline Math: `$ ... $`

Wrap inline mathematical expressions in **single dollar signs** (`$`).

- **Format**: `$formula$`
- **Strict Rule**: No whitespace immediately after opening `$` or before closing `$`.

| Description               | Correct Syntax                                       |
| :------------------------ | :--------------------------------------------------- |
| Variable / Symbol         | `$x$`, `$\alpha$`, `$\Delta T$`                      |
| Simple Equation           | `$E = mc^2$`                                         |
| Subscripts & Superscripts | `$x_1^2 + x_2^2 = r^2$`                              |
| Text inside math          | `$\Delta T = T_{\text{final}} - T_{\text{initial}}$` |
| Fractions                 | `$\frac{a}{b}$`                                      |
| Square Root               | `$\sqrt{x^2 + y^2}$`                                 |

---

### B. Display / Block Math: `$$ ... $$`

Wrap standalone, centered, or multiline formulas in **double dollar signs** (`$$`).

- **Format**:
  ```markdown
  $$
  formula
  $$
  ```
- **Best Practice**: Place opening `$$` and closing `$$` on their own lines, separated by an empty line from surrounding paragraphs.

#### Examples

**1. Fractions, Limits, Integrals, and Sums:**

```markdown
$$
\int_{a}^{b} f(x) \, dx = \lim_{n \to \infty} \sum_{i=1}^{n} f(x_i^*) \Delta x
$$
```

**2. Implication & Physics Equations:**

```markdown
$$
Q = m \cdot c \cdot \Delta T \implies \Delta T = \frac{Q}{m \cdot c}
$$
```

**3. Multiline / Aligned Equations (`aligned` environment):**

```markdown
$$
\begin{aligned}
\nabla \cdot \mathbf{E} &= \frac{\rho}{\varepsilon_0} \\
\nabla \cdot \mathbf{B} &= 0 \\
\nabla \times \mathbf{E} &= -\frac{\partial \mathbf{B}}{\partial t} \\
\nabla \times \mathbf{B} &= \mu_0 \left( \mathbf{J} + \varepsilon_0 \frac{\partial \mathbf{E}}{\partial t} \right)
\end{aligned}
$$
```

**4. Piecewise / Cases (`cases` environment):**

```markdown
$$
f(x) = \begin{cases}
\frac{\sin(x)}{x} & \text{if } x \neq 0 \\
1 & \text{if } x = 0
\end{cases}
$$
```

**5. Matrices (`pmatrix`, `bmatrix`, `matrix`):**

```markdown
$$
\mathbf{A} = \begin{pmatrix}
a & b \\
c & d
\end{pmatrix}, \quad
\det(\mathbf{A}) = ad - bc
$$
```

---

## 2. How NOT to Write LaTeX (Common Pitfalls)

| ❌ What NOT to do            | Why it breaks                                                                   | ✅ What to do instead                                   |
| :--------------------------- | :------------------------------------------------------------------------------ | :------------------------------------------------------ |
| `\( E = mc^2 \)`             | `\( ... \)` is treated as escaped parentheses in markdown, **not** inline math. | Use `$E = mc^2$`                                        |
| `\[ \frac{a}{b} \]`          | `\[ ... \]` is treated as escaped brackets, **not** block math.                 | Use `$$\frac{a}{b}$$`                                   |
| `$ x + y $`                  | Spaces right after `$` or before `$` disable math parsing in `remark-math`.     | Use `$x + y$` (no padding spaces)                       |
| ` ```latex \frac{a}{b} ``` ` | Renders as a raw syntax-highlighted code box, **not** a rendered formula.       | Use `$$ \frac{a}{b} $$`                                 |
| `\documentclass{article}`    | KaTeX only parses mathematical formulas, not full LaTeX documents or preambles. | Only include the mathematical expression.               |
| `$\textbf{**bold**}$`        | Markdown formatting is not evaluated inside math mode.                          | Use LaTeX commands: `\mathbf{x}` or `\text{\textbf{x}}` |
| `$10 and $20`                | Multiple unescaped dollar signs in text can accidentally trigger math mode.     | Escape literal dollar signs: `\$10 and \$20`            |

---

## 3. Quick Reference Cheat Sheet

| Math Requirement   | Recommended Syntax                                         |
| :----------------- | :--------------------------------------------------------- |
| Inline Formula     | `$E = mc^2$`                                               |
| Block Formula      | `$$\Delta T = T_{\text{hot}} - T_{\text{cold}}$$`          |
| Text in Formula    | `\text{words}` (e.g. `$T_{\text{ambient}}$`)               |
| Bold Math Symbol   | `\mathbf{v}` or `\boldsymbol{\theta}`                      |
| Greek Letters      | `\alpha`, `\beta`, `\gamma`, `\Delta`, `\Omega`            |
| Multiplication Dot | `\cdot` (e.g. `$a \cdot b$`)                               |
| Fractions          | `\frac{numerator}{denominator}`                            |
| Roots              | `\sqrt{x}` or `\sqrt[n]{x}`                                |
| Sums & Integrals   | `\sum_{i=1}^N` and `\int_{0}^{\infty}`                     |
| Relations / Arrows | `\le`, `\ge`, `\neq`, `\approx`, `\implies`, `\iff`, `\to` |
