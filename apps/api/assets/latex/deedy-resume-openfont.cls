%% deedy-resume-openfont.cls
%% Single-column CV class. Requires XeLaTeX or LuaLaTeX (fontspec).
%%
%% Fonts come from TeX Live's `raleway` package, so no fonts/raleway/ folder
%% is needed. Raleway ships no italic face, so italics are synthesised with a
%% slant -- see \customitalic below.
%%
%% Every visual constant is a theme key rather than a literal, so the resume
%% editor can restyle a document without touching its content. See \cvtheme at
%% the bottom of this file for the full key list.

\ProvidesClass{deedy-resume-openfont}[2026/08/01 CV class]
\NeedsTeXFormat{LaTeX2e}
\DeclareOption{print}{\def\@cv@print{}}
\DeclareOption*{%
  \PassOptionsToClass{\CurrentOption}{article}
}
\ProcessOptions\relax
\LoadClass[10pt]{article}

% Package Imports
% \RequirePackage is the correct form inside a class file.
% xltxtra/xunicode are deprecated and clash with modern fontspec; fontenc must
% not be loaded alongside fontspec under XeLaTeX. All three are dropped.
\RequirePackage[hmargin=1.45cm, vmargin=1.0cm, footskip=0pt]{geometry}
\RequirePackage[usenames,dvipsnames]{xcolor}
\RequirePackage[hidelinks]{hyperref}
% ATS parsers read PDF metadata; fill it from the class rather than by hand.
\newcommand{\cvmeta}[2]{\hypersetup{pdftitle={#1 -- CV}, pdfauthor={#1},
  pdfsubject={#2}, pdfcreator={}, pdfproducer={}}}
\RequirePackage{titlesec}
\RequirePackage[absolute]{textpos}
\RequirePackage[UKenglish]{babel}
\RequirePackage[UKenglish]{isodate}
\RequirePackage{fontspec}
\RequirePackage{textcomp}
\RequirePackage{longtable}
\RequirePackage{tabularx}
\RequirePackage{enumitem}
\RequirePackage{microtype}
\RequirePackage{keyval}

% Color definitions
% Darkened from the original: 6A6A6A headings paired with an ExtraLight face
% produced strokes too faint to read comfortably on screen or in print.
\definecolor{date}{HTML}{5A5A5A}
\definecolor{primary}{HTML}{1F1F1F}
\definecolor{headings}{HTML}{3D3D3D}
\definecolor{subheadings}{HTML}{222222}
\definecolor{rulecolor}{HTML}{BDBDBD}
\definecolor{accent}{HTML}{2B4C7E}

%% ---------------------------------------------------------------------------
%% Theme parameters
%%
%% Sizes are stored as bare numbers and consumed as `\cv@x pt`, so a theme can
%% rescale the whole document without every macro being edited. The defaults
%% below reproduce the original hand-tuned layout exactly.
%% ---------------------------------------------------------------------------
\def\cv@bodysize{10}       \def\cv@bodyleading{12.5}
\def\cv@namesize{30}       \def\cv@nameleading{34}
\def\cv@taglinesize{10.5}  \def\cv@taglineleading{13}
\def\cv@metasize{9.5}      \def\cv@metaleading{13}
\def\cv@sectionsize{11}    \def\cv@sectionleading{13}
\def\cv@subsize{10.5}      \def\cv@subleading{12}
\def\cv@smallsize{9.5}     \def\cv@smallleading{12}
\def\cv@tracking{6.0}      % uppercase section-heading letterspacing
\def\cv@nametracking{2.0}

\newlength{\cv@sectiongap}   \setlength{\cv@sectiongap}{9pt}
\newlength{\cv@sectionafter} \setlength{\cv@sectionafter}{3pt}
\newlength{\cv@entrygap}     \setlength{\cv@entrygap}{4pt}
\newlength{\cv@itemsep}      \setlength{\cv@itemsep}{1.5pt}
\newlength{\cv@listtopsep}   \setlength{\cv@listtopsep}{3pt}
\newlength{\cv@skillwidth}   \setlength{\cv@skillwidth}{3.3cm}
\newlength{\cv@skillgap}     \setlength{\cv@skillgap}{2.5pt}

% Set main fonts
% Body is Light rather than ExtraLight -- ExtraLight at 10pt is a hairline and
% is the single biggest readability problem in the original class.
\defaultfontfeatures{Ligatures=TeX}

% \newfontfamily errors when the control sequence already exists, and a theme
% may switch families more than once, so every family declaration goes through
% this. #1 target macro, #2 font file, #3 extra fontspec features.
\newcommand{\cv@setfamily}[3]{%
  \expandafter\ifx\csname\expandafter\@gobble\string#1\endcsname\relax
    \newfontfamily#1{#2}[#3]%
  \else
    \setfontfamily#1{#2}[#3]%
  \fi
}

% #1 target macro, #2 wanted file, #3 fallback file, #4 extra features.
\newcommand{\cv@declarefamily}[4]{%
  \IfFontExistsTF{#2}%
    {\cv@setfamily{#1}{#2}{#4}}%
    {\cv@setfamily{#1}{#3}{#4}}%
}

% Latin Modern ships with every TeX distribution, so it is the one family that
% can always be loaded. A CV in the wrong typeface beats a CV that fails to
% build on a machine missing an optional font package.
% The faces are named by file, not by family: family-name lookup goes through
% fontconfig, which is frequently absent in a container.
\newcommand{\cv@latinmodern}{%
  \setmainfont{lmroman10-regular.otf}[
    BoldFont       = lmroman10-bold.otf,
    ItalicFont     = lmroman10-italic.otf,
    BoldItalicFont = lmroman10-bolditalic.otf,
    Color          = primary
  ]%
  \setsansfont{lmsans10-regular.otf}[
    Scale      = MatchLowercase,
    BoldFont   = lmsans10-bold.otf,
    ItalicFont = lmsans10-oblique.otf,
    Color      = primary
  ]%
  \cv@setfamily\thinfont{lmsans10-regular.otf}{}%
  \cv@setfamily\lightfont{lmroman10-regular.otf}{}%
  \cv@setfamily\mediumfont{lmroman10-regular.otf}{}%
  \cv@setfamily\semiboldfont{lmroman10-bold.otf}{}%
  \cv@setfamily\headingfont{lmsans10-regular.otf}{LetterSpace=\cv@tracking}%
  \cv@setfamily\namefont{lmsans10-regular.otf}{LetterSpace=\cv@nametracking}%
}

% Applies one font family: #1 light/body, #2 bold, #3 medium, #4 extra-light.
% Italics are synthesised for every face because several of these families ship
% no italic file, and a missing ItalicFont is a hard error under fontspec.
\newcommand{\cv@applyfont}[4]{%
  \IfFontExistsTF{#1}{%
    \setmainfont{#1}[
      BoldFont           = #2,
      ItalicFont         = #1,
      ItalicFeatures     = {FakeSlant=0.15},
      BoldItalicFont     = #2,
      BoldItalicFeatures = {FakeSlant=0.15},
      Color              = primary
    ]%
    \setsansfont{#1}[
      Scale              = MatchLowercase,
      BoldFont           = #2,
      ItalicFont         = #1,
      ItalicFeatures     = {FakeSlant=0.15},
      Color              = primary
    ]%
    \cv@declarefamily\thinfont{#4}{#1}{}%
    \cv@declarefamily\lightfont{#1}{#1}{}%
    \cv@declarefamily\mediumfont{#3}{#1}{}%
    \cv@declarefamily\semiboldfont{#2}{#1}{}%
    % Uppercase headings need tracking or the letterforms crowd together.
    \cv@declarefamily\headingfont{#3}{#1}{LetterSpace=\cv@tracking}%
    \cv@declarefamily\namefont{#4}{#1}{LetterSpace=\cv@nametracking}%
  }{%
    \cv@latinmodern
  }%
}

% The named presets. Every file here ships inside TeX Live, so no font is ever
% fetched or installed separately -- the build stays offline.
\newcommand{\cv@fontpreset}[1]{%
  \def\cv@fp{#1}%
  \def\cv@tmp{raleway}\ifx\cv@fp\cv@tmp
    \cv@applyfont{Raleway-Light.otf}{Raleway-SemiBold.otf}{Raleway-Medium.otf}{Raleway-ExtraLight.otf}%
  \else\def\cv@tmp{sourcesans}\ifx\cv@fp\cv@tmp
    \cv@applyfont{SourceSansPro-Light.otf}{SourceSansPro-Semibold.otf}{SourceSansPro-Regular.otf}{SourceSansPro-ExtraLight.otf}%
  \else\def\cv@tmp{fira}\ifx\cv@fp\cv@tmp
    \cv@applyfont{FiraSans-Light.otf}{FiraSans-SemiBold.otf}{FiraSans-Medium.otf}{FiraSans-Thin.otf}%
  \else\def\cv@tmp{garamond}\ifx\cv@fp\cv@tmp
    \cv@applyfont{EBGaramond-Regular.otf}{EBGaramond-SemiBold.otf}{EBGaramond-Medium.otf}{EBGaramond-Regular.otf}%
  \else
    \cv@latinmodern
  \fi\fi\fi\fi
}

\cv@fontpreset{raleway}

\newcommand{\custombold}[1]{{\color{subheadings}\semiboldfont #1}}
\newcommand{\customitalic}[1]{{\color{subheadings}\lightfont\itshape #1}}
\newcommand{\customtitle}[1]{{\centering\color{subheadings}\lightfont\fontsize{\cv@subsize pt}{\cv@subleading pt}\selectfont #1\par}}

% ATS hardening. Text extractors rejoin words broken by hyphenation, but when
% the break lands on an EXPLICIT hyphen they swallow it: "e-invoicing" comes out
% as "einvoicing" and "react-native-video-zoom" as "react-native-videozoom",
% which silently breaks keyword matching. Suppressing both kinds of break makes
% every word extract intact; \emergencystretch absorbs the slack so no line
% overflows.
% Soft (mid-word) hyphenation is left enabled but discouraged: extractors rejoin
% those correctly, and banning it outright forces visibly loose justification.
% Explicit-hyphen breaks are what actually corrupt the text, so those are barred.
\hyphenpenalty=2000
\exhyphenpenalty=10000
\tolerance=1200
\emergencystretch=2em

% Global spacing: no paragraph indents, small inter-paragraph gap.
\setlength{\parindent}{0pt}
\setlength{\parskip}{0pt}
\setlength{\tabcolsep}{0pt}
\raggedbottom
\pagestyle{empty}

% article fixes \normalsize at its class option, so the themed body size has to
% be installed once the preamble -- and therefore \cvtheme -- has been read.
\AtBeginDocument{\fontsize{\cv@bodysize pt}{\cv@bodyleading pt}\selectfont}

% Date command
\setlength{\TPHorizModule}{1mm}
\setlength{\TPVertModule}{1mm}
\textblockorigin{0mm}{5mm}
\newcommand{\lastupdated}{\begin{textblock}{60}(150,0)
\color{date}\lightfont\fontsize{8pt}{10pt}\selectfont
\raggedleft Last updated \today
\end{textblock}}

% The \par inside the group is essential: it ends the paragraph while
% \centering is still in scope, so the centring does not leak onwards.
\newcommand{\linksline}[1]{%
    {\centering\color{headings}\lightfont\fontsize{\cv@metasize pt}{\cv@metaleading pt}\selectfont #1\par}%
    \vspace{3pt}
}

\newcommand{\infoline}[1]{%
    {\centering\color{headings}\lightfont\fontsize{\cv@metasize pt}{\cv@metaleading pt}\selectfont #1\par}%
    \vspace{3pt}
}

% Name command -- #1 first name, #2 last name, #3 tagline beneath.
% The original set \fontsize{40pt}{10cm}: a 10cm baselineskip, which injected a
% page-height gap under the name. Baselineskip is now proportional to the size.
\newcommand{\namesection}[3]{%
    {\centering
        {\namefont\fontsize{\cv@namesize pt}{\cv@nameleading pt}\selectfont\color{subheadings}#1 \custombold{#2}}\par
        \vspace{1pt}
        {\color{headings}\mediumfont\fontsize{\cv@taglinesize pt}{\cv@taglineleading pt}\selectfont #3}\par
    }%
    \vspace{4pt}
}

\newcommand{\underlineheader}{%
    \noindent\makebox[\linewidth]{\color{rulecolor}\rule{\linewidth}{0.4pt}}
    \vspace{-4pt}
}

% Headings command -- rule underneath gives each section a clear anchor when
% the page is skimmed.
% \MakeUppercase goes in the <before-code> slot so titlesec passes the title to
% it as an argument; putting it at the end of <format> breaks \titlerule.
\titleformat{\section}
  {\color{headings}\headingfont\fontsize{\cv@sectionsize pt}{\cv@sectionleading pt}\selectfont\raggedright}
  {}{0em}{\MakeUppercase}
  [\vspace{2pt}{\color{rulecolor}\titlerule[0.6pt]}]
\titlespacing*{\section}{0pt}{\cv@sectiongap}{\cv@sectionafter}

% Subheadings command
\titleformat{\subsection}
  {\color{subheadings}\semiboldfont\fontsize{\cv@subsize pt}{\cv@subleading pt}\selectfont}
  {}{0em}{\MakeUppercase}
\titlespacing*{\subsection}{0pt}{\cv@entrygap}{2pt}
\titlespacing*{\subsubsection}{0pt}{\cv@entrygap}{2pt}

\newcommand{\runsubsection}[1]{%
  {\color{subheadings}\semiboldfont\fontsize{\cv@subsize pt}{\cv@subleading pt}\selectfont #1}%
}

% Descriptors command
\newcommand{\descript}[1]{%
  {\color{headings}\lightfont\fontsize{\cv@smallsize pt}{\cv@smallleading pt}\selectfont\itshape #1}%
}

% Location command
\newcommand{\location}[1]{%
  {\color{date}\lightfont\fontsize{\cv@smallsize pt}{\cv@smallleading pt}\selectfont #1}%
}

% Accent-coloured run, for themes that want one highlight colour in the body.
\newcommand{\accenttext}[1]{{\color{accent}\semiboldfont #1}}

% A heading row with the title flush left and date/links flush right.
\newcommand{\entryline}[2]{%
  \noindent\begin{tabular*}{\linewidth}{@{}l@{\extracolsep{\fill}}r@{}}
    #1 & #2
  \end{tabular*}\par
}

% Category label for the skills column. Deliberately Medium rather than
% SemiBold: the values carry the bolding, so a same-weight label would flatten
% the hierarchy and make the block read as one undifferentiated mass.
\newcommand{\skilllabel}[1]{%
  {\color{headings}\mediumfont\fontsize{\cv@smallsize pt}{\cv@smallleading pt}\selectfont #1}%
}

% Skills row. \strut in both cells is required: \newfontfamily resets
% \baselineskip, which otherwise drops the label a full line below its values.
\newcommand{\skillrow}[2]{%
  \noindent\begin{tabularx}{\linewidth}%
    {@{}p{\cv@skillwidth}@{\hspace{8pt}}>{\raggedright\arraybackslash}X@{}}
    \strut\skilllabel{#1} & \strut #2
  \end{tabularx}\par\vspace{\cv@skillgap}
}

% Section separators command
\newcommand{\sectionsep}{\vspace{6pt}}
\newcommand{\entrysep}{\vspace{\cv@entrygap}}

% Bullet lists with fewer gaps command
\newenvironment{tightemize}
  {\begin{itemize}[leftmargin=1.1em, itemsep=\cv@itemsep, parsep=0pt,
                   topsep=\cv@listtopsep, partopsep=0pt, labelsep=0.45em,
                   label=\textbullet]}
  {\end{itemize}}

% Inline separator for tech-stack and link lists. \nobreak stops a line ending
% just before the bar, so wrapped lines never begin with a dangling separator.
\newcommand{\sep}{\nobreak\hspace{3.5pt}\textcolor{rulecolor}{\textbar}\allowbreak\hspace{3.5pt}}

%% ---------------------------------------------------------------------------
%% \cvtheme{key=value, ...}
%%
%% Call it once in the preamble, after \documentclass. An unknown key is an
%% error, so a typo fails the build instead of silently doing nothing.
%%
%%   font        raleway | sourcesans | fira | garamond | latinmodern
%%   primary, headings, subheadings, date, rule, accent   six hex digits, no '#'
%%   bodysize, bodyleading, namesize, nameleading, taglinesize, taglineleading,
%%   metasize, metaleading, sectionsize, sectionleading, subsize, subleading,
%%   smallsize, smallleading                              bare point values
%%   tracking, nametracking                               letterspacing
%%   sectiongap, sectionafter, entrygap, itemsep, listtopsep, skillwidth,
%%   skillgap                                             TeX lengths
%%   hmargin, vmargin                                     page margins
%% ---------------------------------------------------------------------------
\define@key{cvtheme}{primary}{\definecolor{primary}{HTML}{#1}}
\define@key{cvtheme}{headings}{\definecolor{headings}{HTML}{#1}}
\define@key{cvtheme}{subheadings}{\definecolor{subheadings}{HTML}{#1}}
\define@key{cvtheme}{date}{\definecolor{date}{HTML}{#1}}
\define@key{cvtheme}{rule}{\definecolor{rulecolor}{HTML}{#1}}
\define@key{cvtheme}{accent}{\definecolor{accent}{HTML}{#1}}

\define@key{cvtheme}{bodysize}{\def\cv@bodysize{#1}}
\define@key{cvtheme}{bodyleading}{\def\cv@bodyleading{#1}}
\define@key{cvtheme}{namesize}{\def\cv@namesize{#1}}
\define@key{cvtheme}{nameleading}{\def\cv@nameleading{#1}}
\define@key{cvtheme}{taglinesize}{\def\cv@taglinesize{#1}}
\define@key{cvtheme}{taglineleading}{\def\cv@taglineleading{#1}}
\define@key{cvtheme}{metasize}{\def\cv@metasize{#1}}
\define@key{cvtheme}{metaleading}{\def\cv@metaleading{#1}}
\define@key{cvtheme}{sectionsize}{\def\cv@sectionsize{#1}}
\define@key{cvtheme}{sectionleading}{\def\cv@sectionleading{#1}}
\define@key{cvtheme}{subsize}{\def\cv@subsize{#1}}
\define@key{cvtheme}{subleading}{\def\cv@subleading{#1}}
\define@key{cvtheme}{smallsize}{\def\cv@smallsize{#1}}
\define@key{cvtheme}{smallleading}{\def\cv@smallleading{#1}}
\define@key{cvtheme}{tracking}{\def\cv@tracking{#1}}
\define@key{cvtheme}{nametracking}{\def\cv@nametracking{#1}}

\define@key{cvtheme}{sectiongap}{\setlength{\cv@sectiongap}{#1}}
\define@key{cvtheme}{sectionafter}{\setlength{\cv@sectionafter}{#1}}
\define@key{cvtheme}{entrygap}{\setlength{\cv@entrygap}{#1}}
\define@key{cvtheme}{itemsep}{\setlength{\cv@itemsep}{#1}}
\define@key{cvtheme}{listtopsep}{\setlength{\cv@listtopsep}{#1}}
\define@key{cvtheme}{skillwidth}{\setlength{\cv@skillwidth}{#1}}
\define@key{cvtheme}{skillgap}{\setlength{\cv@skillgap}{#1}}

\define@key{cvtheme}{hmargin}{\geometry{hmargin=#1}}
\define@key{cvtheme}{vmargin}{\geometry{vmargin=#1}}

% The font is applied after every other key: the tracking values must already
% be current when the letterspaced families are declared.
\define@key{cvtheme}{font}{\def\cv@fontchoice{#1}}
\def\cv@fontchoice{raleway}

\newcommand{\cvtheme}[1]{%
  \setkeys{cvtheme}{#1}%
  % \cv@fontpreset compares its argument with \ifx, so the chosen name has to
  % arrive as characters rather than as the macro holding them.
  \expandafter\cv@fontpreset\expandafter{\cv@fontchoice}%
  % titlesec freezes the spacing when \titlespacing runs, so re-issue it with
  % whatever lengths the theme just set.
  \titlespacing*{\section}{0pt}{\cv@sectiongap}{\cv@sectionafter}%
  \titlespacing*{\subsection}{0pt}{\cv@entrygap}{2pt}%
  \titlespacing*{\subsubsection}{0pt}{\cv@entrygap}{2pt}%
}
