/*---------------------------------------------------------
 *  Author: Benjamin R. Bray
 *  License: MIT (see LICENSE in project root for details)
 *--------------------------------------------------------*/

// prosemirror imports
import {
  Node as ProseNode,
  Fragment,
  MarkSpec,
  NodeSpec,
  Schema,
  SchemaSpec,
  NodeType,
} from "@remirror/pm/model";
import {
  defaultBlockMathParseRules,
  defaultInlineMathParseRules,
} from "./math-paste-rules";

// prosemirror imports
import {
  EditorState,
  Transaction,
  TextSelection,
  NodeSelection,
  Plugin as ProsePlugin,
  PluginKey,
  PluginSpec,
} from "@remirror/pm/state";
import { NodeView, EditorView, Decoration } from "@remirror/pm/view";
import { StepMap } from "prosemirror-transform";
import { keymap } from "prosemirror-keymap";
import {
  newlineInCode,
  chainCommands,
  deleteSelection,
  liftEmptyBlock,
} from "@remirror/pm/commands";

import { Command } from "@remirror/pm/state";

// katex
import katex, { ParseError, KatexOptions } from "katex";

// ---------------------------------------------------------
// Utils

import { InputRule } from "@remirror/pm/inputrules";

////////////////////////////////////////////////////////////

// ---- Inline Input Rules ------------------------------ //

// simple input rule for inline math
export const REGEX_INLINE_MATH_DOLLARS: RegExp = /\$(.+)\$/; //new RegExp("\$(.+)\$", "i");

////////////////////////////////////////////////////////////

export function makeInlineMathInputRule(
  pattern: RegExp,
  nodeType: NodeType,
  getAttrs?: (match: string[]) => any
) {
  return new InputRule(pattern, (state, match, start, end) => {
    let $start = state.doc.resolve(start);
    let index = $start.index();
    let $end = state.doc.resolve(end);
    // get attrs
    let attrs = getAttrs instanceof Function ? getAttrs(match) : getAttrs;
    // check if replacement valid
    if (!$start.parent.canReplaceWith(index, $end.index(), nodeType)) {
      return null;
    }
    // perform replacement
    return state.tr.replaceRangeWith(
      start,
      end,
      nodeType.create(attrs, nodeType.schema.text(match[1]))
    );
  });
}

export function makeBlockMathInputRule(
  pattern: RegExp,
  nodeType: NodeType,
  getAttrs?: (match: string[]) => any
) {
  return new InputRule(pattern, (state, match, start, end) => {
    let $start = state.doc.resolve(start);
    let attrs = getAttrs instanceof Function ? getAttrs(match) : getAttrs;
    if (
      !$start
        .node(-1)
        .canReplaceWith($start.index(-1), $start.indexAfter(-1), nodeType)
    )
      return null;
    let tr = state.tr
      .delete(start, end)
      .setBlockType(start, start, nodeType, attrs);

    return tr.setSelection(
      NodeSelection.create(tr.doc, tr.mapping.map($start.pos - 1))
    );
  });
}

////////////////////////////////////////////////////////////////////////////////

// infer generic `Nodes` and `Marks` type parameters for a SchemaSpec
export type SchemaSpecNodeT<Spec> = Spec extends SchemaSpec<infer N, infer _>
  ? N
  : never;
export type SchemaSpecMarkT<Spec> = Spec extends SchemaSpec<infer _, infer M>
  ? M
  : never;

export type SchemaNodeT<S> = S extends Schema<infer N, infer _> ? N : never;
export type SchemaMarkT<S> = S extends Schema<infer _, infer M> ? M : never;

/**
 * A ProseMirror command for determining whether to exit a math block, based on
 * specific conditions.  Normally called when the user has
 *
 * @param outerView The main ProseMirror EditorView containing this math node.
 * @param dir Used to indicate desired cursor position upon closing a math node.
 *     When set to -1, cursor will be placed BEFORE the math node.
 *     When set to +1, cursor will be placed AFTER the math node.
 * @param borderMode An exit condition based on cursor position and direction.
 * @param requireEmptySelection When TRUE, only exit the math node when the
 *    (inner) selection is empty.
 * @returns A new ProseMirror command based on the input configuration.
 */
export function collapseMathCmd(
  outerView: EditorView,
  dir: 1 | -1,
  requireOnBorder: boolean,
  requireEmptySelection: boolean = true
): Command {
  // create a new ProseMirror command based on the input conditions
  return (
    innerState: EditorState,
    dispatch: ((tr: Transaction) => void) | undefined
  ) => {
    // get selection info
    let outerState: EditorState = outerView.state;
    let { to: outerTo, from: outerFrom } = outerState.selection;
    let { to: innerTo, from: innerFrom } = innerState.selection;

    // only exit math node when selection is empty
    if (requireEmptySelection && innerTo !== innerFrom) {
      return false;
    }
    let currentPos: number = dir > 0 ? innerTo : innerFrom;

    // when requireOnBorder is TRUE, collapse only when cursor
    // is about to leave the bounds of the math node
    if (requireOnBorder) {
      // (subtract two from nodeSize to account for start and end tokens)
      let nodeSize = innerState.doc.nodeSize - 2;

      // early return if exit conditions not met
      if (dir > 0 && currentPos < nodeSize) {
        return false;
      }
      if (dir < 0 && currentPos > 0) {
        return false;
      }
    }

    // all exit conditions met, so close the math node by moving the cursor outside
    if (dispatch) {
      // set outer selection to be outside of the nodeview
      let targetPos: number = dir > 0 ? outerTo : outerFrom;

      outerView.dispatch(
        outerState.tr.setSelection(
          TextSelection.create(outerState.doc, targetPos)
        )
      );

      // must return focus to the outer view, otherwise no cursor will appear
      outerView.focus();
    }

    return true;
  };
}

////////////////////////////////////////////////////////////

// force typescript to infer generic type arguments for SchemaSpec
function createSchemaSpec(spec) {
  return spec;
}

// bare minimum ProseMirror schema for working with math nodes
export const mathSchemaSpec = createSchemaSpec({
  nodes: {
    // :: NodeSpec top-level document node
    doc: {
      content: "block+",
    },
    paragraph: {
      content: "inline*",
      group: "block",
      parseDOM: [{ tag: "p" }],
      toDOM() {
        return ["p", 0];
      },
    },
    math_inline: {
      group: "inline math",
      content: "text*",
      inline: true,
      atom: true,
      toDOM: () => ["math-inline", { class: "math-node" }, 0],
      parseDOM: [{ tag: "math-inline" }, ...defaultInlineMathParseRules],
    },
    math_display: {
      group: "block math",
      content: "text*",
      atom: true,
      code: true,
      toDOM: () => ["math-display", { class: "math-node" }, 0],
      parseDOM: [{ tag: "math-display" }, ...defaultBlockMathParseRules],
    },
    text: {
      group: "inline",
    },
  },
  marks: {
    math_select: {
      toDOM() {
        return ["math-select", 0];
      },
      parseDOM: [{ tag: "math-select" }],
    },
  },
});

/**
 * Use the prosemirror-math default SchemaSpec to create a new Schema.
 */
export function createMathSchema() {
  return new Schema(mathSchemaSpec);
}

/**
 * Create a new SchemaSpec by adding math nodes to an existing spec.

 * @deprecated This function is included for demonstration/testing only. For the
 *     time being, I highly recommend adding the math nodes manually to your own
 *     ProseMirror spec to avoid unexpected interactions between the math nodes
 *     and your own spec.  Use the example spec for reference.
 *
 * @param baseSpec The SchemaSpec to extend.  Must specify a `marks` field, and
 *     must be a raw object (not an OrderedMap).
 */
export function extendMathSchemaSpec(baseSpec) {
  let nodes = { ...baseSpec.nodes, ...mathSchemaSpec.nodes };
  let marks = { ...baseSpec.marks, ...mathSchemaSpec.marks };
  return { nodes, marks, topNode: baseSpec.topNode };
}

// ---------------------------------------------------------
// Node view

/*---------------------------------------------------------
 *  Author: Benjamin R. Bray
 *  License: MIT (see LICENSE in project root for details)
 *--------------------------------------------------------*/

//// INLINE MATH NODEVIEW //////////////////////////////////

export interface ICursorPosObserver {
  /** indicates on which side cursor should appear when this node is selected */
  cursorSide: "start" | "end";
  /**  */
  updateCursorPos(state: EditorState): void;
}

interface IMathViewOptions {
  /** Dom element name to use for this NodeView */
  tagName?: string;
  /** Whether to render this node as display or inline math. */
  katexOptions?: KatexOptions;
}

export class MathView implements NodeView, ICursorPosObserver {
  // nodeview params
  private _node: ProseNode;
  private _outerView: EditorView;
  private _getPos: () => number;

  // nodeview dom
  dom: HTMLElement;
  private _mathRenderElt: HTMLElement | undefined;
  private _mathSrcElt: HTMLElement | undefined;
  private _innerView: EditorView | undefined;

  // internal state
  cursorSide: "start" | "end";
  private _katexOptions: KatexOptions;
  private _tagName: string;
  private _isEditing: boolean;
  private _onDestroy: (() => void) | undefined;
  private _mathPluginKey: PluginKey<IMathPluginState>;

  // == Lifecycle ===================================== //

  /**
   * @param onDestroy Callback for when this NodeView is destroyed.
   *     This NodeView should unregister itself from the list of ICursorPosObservers.
   *
   * Math Views support the following options:
   * @option displayMode If TRUE, will render math in display mode, otherwise in inline mode.
   * @option tagName HTML tag name to use for this NodeView.  If none is provided,
   *     will use the node name with underscores converted to hyphens.
   */
  constructor(
    node: ProseNode,
    view: EditorView,
    getPos: () => number,
    options: IMathViewOptions = {},
    mathPluginKey: PluginKey<IMathPluginState>,
    onDestroy?: () => void
  ) {
    // store arguments
    this._node = node;
    this._outerView = view;
    this._getPos = getPos;
    this._onDestroy = onDestroy && onDestroy.bind(this);
    this._mathPluginKey = mathPluginKey;

    // editing state
    this.cursorSide = "start";
    this._isEditing = false;

    // options
    this._katexOptions = Object.assign(
      { globalGroup: true, throwOnError: false },
      options.katexOptions
    );
    this._tagName = options.tagName || this._node.type.name.replace("_", "-");

    // create dom representation of nodeview
    this.dom = document.createElement(this._tagName);
    this.dom.classList.add("math-node");

    this._mathRenderElt = document.createElement("span");
    this._mathRenderElt.textContent = "";
    this._mathRenderElt.classList.add("math-render");
    this.dom.appendChild(this._mathRenderElt);

    this._mathSrcElt = document.createElement("span");
    this._mathSrcElt.classList.add("math-src");
    this.dom.appendChild(this._mathSrcElt);

    // ensure
    this.dom.addEventListener("click", () => this.ensureFocus());

    // render initial content
    this.renderMath();
  }

  destroy() {
    // close the inner editor without rendering
    this.closeEditor(false);

    // clean up dom elements
    if (this._mathRenderElt) {
      this._mathRenderElt.remove();
      delete this._mathRenderElt;
    }
    if (this._mathSrcElt) {
      this._mathSrcElt.remove();
      delete this._mathSrcElt;
    }

    this.dom.remove();
  }

  /**
   * Ensure focus on the inner editor whenever this node has focus.
   * This helps to prevent accidental deletions of math blocks.
   */
  ensureFocus() {
    if (this._innerView && this._outerView.hasFocus()) {
      this._innerView.focus();
    }
  }

  // == Updates ======================================= //

  update(node: ProseNode, decorations: readonly Decoration[]) {
    if (!node.sameMarkup(this._node)) return false;
    this._node = node;

    if (this._innerView) {
      let state = this._innerView.state;

      let start = node.content.findDiffStart(state.doc.content);
      if (start != null) {
        let diff = node.content.findDiffEnd(state.doc.content as any);
        if (diff) {
          let { a: endA, b: endB } = diff;
          let overlap = start - Math.min(endA, endB);
          if (overlap > 0) {
            endA += overlap;
            endB += overlap;
          }
          this._innerView.dispatch(
            state.tr
              .replace(start, endB, node.slice(start, endA))
              .setMeta("fromOutside", true)
          );
        }
      }
    }

    if (!this._isEditing) {
      this.renderMath();
    }

    return true;
  }

  updateCursorPos(state: EditorState): void {
    const pos = this._getPos();
    const size = this._node.nodeSize;
    const inPmSelection =
      state.selection.from < pos + size && pos < state.selection.to;

    if (!inPmSelection) {
      this.cursorSide = pos < state.selection.from ? "end" : "start";
    }
  }

  // == Events ===================================== //

  selectNode() {
    if (!this._outerView.editable) {
      return;
    }
    this.dom.classList.add("ProseMirror-selectednode");
    if (!this._isEditing) {
      this.openEditor();
    }
  }

  deselectNode() {
    this.dom.classList.remove("ProseMirror-selectednode");
    if (this._isEditing) {
      this.closeEditor();
    }
  }

  stopEvent(event: Event): boolean {
    return (
      this._innerView !== undefined &&
      event.target !== undefined &&
      this._innerView.dom.contains(event.target as Node)
    );
  }

  ignoreMutation() {
    return true;
  }

  // == Rendering ===================================== //

  renderMath() {
    if (!this._mathRenderElt) {
      return;
    }

    // get tex string to render
    let content = this._node.content;
    let texString = "";
    if (content.size > 0 && content[0].textContent !== null) {
      texString = content[0].textContent.trim();
    }

    // empty math?
    if (texString.length < 1) {
      this.dom.classList.add("empty-math");
      // clear rendered math, since this node is in an invalid state
      while (this._mathRenderElt.firstChild) {
        this._mathRenderElt.firstChild.remove();
      }
      // do not render empty math
      return;
    } else {
      this.dom.classList.remove("empty-math");
    }

    // render katex, but fail gracefully
    try {
      katex.render(texString, this._mathRenderElt, this._katexOptions);
      this._mathRenderElt.classList.remove("parse-error");
      this.dom.setAttribute("title", "");
    } catch (err) {
      if (err instanceof katex.ParseError) {
        console.error(err);
        this._mathRenderElt.classList.add("parse-error");
        this.dom.setAttribute("title", (err as katex.ParseError).toString());
      } else {
        throw err;
      }
    }
  }

  // == Inner Editor ================================== //

  dispatchInner(tr: Transaction) {
    if (!this._innerView) {
      return;
    }
    let { state, transactions } = this._innerView.state.applyTransaction(tr);
    this._innerView.updateState(state);

    if (!tr.getMeta("fromOutside")) {
      let outerTr = this._outerView.state.tr,
        offsetMap = StepMap.offset(this._getPos() + 1);
      for (let i = 0; i < transactions.length; i++) {
        let steps = transactions[i].steps;
        for (let j = 0; j < steps.length; j++) {
          let mapped = steps[j].map(offsetMap);
          if (!mapped) {
            throw Error("step discarded!");
          }
          outerTr.step(mapped);
        }
      }
      if (outerTr.docChanged) this._outerView.dispatch(outerTr);
    }
  }

  openEditor() {
    if (this._innerView) {
      throw Error("inner view should not exist!");
    }

    // create a nested ProseMirror view
    // @ts-ignore
    this._innerView = new EditorView(this._mathSrcElt, {
      state: EditorState.create({
        doc: this._node,
        plugins: [
          keymap({
            Tab: (state, dispatch) => {
              if (dispatch) {
                dispatch(state.tr.insertText("\t"));
              }
              return true;
            },
            Backspace: chainCommands(
              deleteSelection,
              (state, dispatch, tr_inner) => {
                // default backspace behavior for non-empty selections
                if (!state.selection.empty) {
                  return false;
                }
                // default backspace behavior when math node is non-empty
                if (this._node.textContent.length > 0) {
                  return false;
                }
                // otherwise, we want to delete the empty math node and focus the outer view
                this._outerView.dispatch(
                  this._outerView.state.tr.insertText("")
                );
                this._outerView.focus();
                return true;
              }
            ),
            "Ctrl-Backspace": (state, dispatch, tr_inner) => {
              // delete math node and focus the outer view
              this._outerView.dispatch(this._outerView.state.tr.insertText(""));
              this._outerView.focus();
              return true;
            },
            Enter: chainCommands(
              newlineInCode,
              collapseMathCmd(this._outerView, +1, false)
            ),
            "Ctrl-Enter": collapseMathCmd(this._outerView, +1, false),
            ArrowLeft: collapseMathCmd(this._outerView, -1, true),
            ArrowRight: collapseMathCmd(this._outerView, +1, true),
            ArrowUp: collapseMathCmd(this._outerView, -1, true),
            ArrowDown: collapseMathCmd(this._outerView, +1, true),
          }),
        ],
      }),
      dispatchTransaction: this.dispatchInner.bind(this),
    });

    // focus element
    let innerState = this._innerView.state;
    this._innerView.focus();

    // request outer cursor position before math node was selected
    let maybePos = this._mathPluginKey.getState(
      this._outerView.state
    )?.prevCursorPos;
    if (maybePos === null || maybePos === undefined) {
      console.error(
        "[prosemirror-math] Error:  Unable to fetch math plugin state from key."
      );
    }
    let prevCursorPos: number = maybePos ?? 0;

    // compute position that cursor should appear within the expanded math node
    let innerPos =
      prevCursorPos <= this._getPos() ? 0 : this._node.nodeSize - 2;
    this._innerView.dispatch(
      innerState.tr.setSelection(TextSelection.create(innerState.doc, innerPos))
    );

    this._isEditing = true;
  }

  /**
   * Called when the inner ProseMirror editor should close.
   *
   * @param render Optionally update the rendered math after closing. (which
   *    is generally what we want to do, since the user is done editing!)
   */
  closeEditor(render: boolean = true) {
    if (this._innerView) {
      this._innerView.destroy();
      this._innerView = undefined;
    }

    if (render) {
      this.renderMath();
    }
    this._isEditing = false;
  }
}

// ---------------------------------------------------------
// Plugin

/*---------------------------------------------------------
 *  Author: Benjamin R. Bray
 *  License: MIT (see LICENSE in project root for details)
 *--------------------------------------------------------*/

////////////////////////////////////////////////////////////

export interface IMathPluginState {
  macros: { [cmd: string]: string };
  /** A list of currently active `NodeView`s, in insertion order. */
  activeNodeViews: MathView[];
  /**
   * Used to determine whether to place the cursor in the front- or back-most
   * position when expanding a math node, without overriding the default arrow
   * key behavior.
   */
  prevCursorPos: number;
}

// uniquely identifies the prosemirror-math plugin
const MATH_PLUGIN_KEY = new PluginKey<IMathPluginState>("prosemirror-math");
console.log("===", MATH_PLUGIN_KEY);

/**
 * Returns a function suitable for passing as a field in `EditorProps.nodeViews`.
 * @param displayMode TRUE for block math, FALSE for inline math.
 * @see https://prosemirror.net/docs/ref/#view.EditorProps.nodeViews
 */
export function createMathView(displayMode: boolean) {
  return (
    node: ProseNode,
    view: EditorView,
    getPos: () => number | undefined
  ): MathView => {
    /** @todo is this necessary?
     * Docs says that for any function proprs, the current plugin instance
     * will be bound to `this`.  However, the typings don't reflect this.
     */
    console.log("The key", MATH_PLUGIN_KEY);
    console.log("The state", view.state);
    let pluginState = MATH_PLUGIN_KEY.getState(view.state);
    console.log("pluginstate", pluginState);
    if (!pluginState) {
      throw new Error("no math plugin!");
    }
    let nodeViews = pluginState.activeNodeViews;

    // set up NodeView
    let nodeView = new MathView(
      node,
      view,
      getPos as () => number,
      { katexOptions: { displayMode, macros: pluginState.macros } },
      MATH_PLUGIN_KEY,
      () => {
        nodeViews.splice(nodeViews.indexOf(nodeView));
      }
    );

    nodeViews.push(nodeView);
    return nodeView;
  };
}

let mathPluginSpec: PluginSpec<IMathPluginState> = {
  key: MATH_PLUGIN_KEY,
  state: {
    init(config, instance) {
      return {
        macros: {},
        activeNodeViews: [],
        prevCursorPos: 0,
      };
    },
    apply(tr, value, oldState, newState) {
      // produce updated state field for this plugin
      return {
        // these values are left unchanged
        activeNodeViews: value.activeNodeViews,
        macros: value.macros,
        // update with the second-most recent cursor pos
        prevCursorPos: oldState.selection.from,
      };
    },
    /** @todo (8/21/20) implement serialization for math plugin */
    // toJSON(value) { },
    // fromJSON(config, value, state){ return {}; }
  },
  props: {
    nodeViews: {
      // @ts-ignore
      math_inline: createMathView(false),
      // @ts-ignore
      math_display: createMathView(true),
    },
  },
};

export const mathPlugin = new ProsePlugin(mathPluginSpec);
