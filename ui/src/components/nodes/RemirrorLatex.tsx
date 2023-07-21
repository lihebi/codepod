import {
  ApplySchemaAttributes,
  extension,
  ExtensionTag,
  MarkExtension,
  MarkExtensionSpec,
  MarkSpecOverride,
  NodeExtension,
  ExtensionPriority,
  PlainExtension,
  command,
  PrimitiveSelection,
  CommandFunction,
  getTextSelection,
  toggleMark,
  NodeExtensionSpec,
  NodeSpecOverride,
  CreateExtensionPlugin,
  NodeViewMethod,
  nodeInputRule,
  Transaction,
  isNodeSelection,
  invariant,
  ErrorConstant,
  ProsemirrorNode,
} from "@remirror/core";

// import { PluginKey, PluginSpec } from "prosemirror-state";
import {
  PluginKey,
  PluginSpec,
  Plugin as ProsePlugin,
  NodeSelection,
} from "@remirror/pm/state";
import { TextSelection } from "@remirror/pm/state";

import {
  createMathSchema,
  mathPlugin,
  MathView,
  createMathView,
  makeInlineMathInputRule,
  REGEX_INLINE_MATH_DOLLARS,
  // } from "@benrbray/prosemirror-math";
} from "./math";

import { Schema, Node as ProseNode } from "prosemirror-model";
import { InputRule } from "@remirror/pm/inputrules";
import { ExtensionListTheme } from "remirror";

let editorSchema = createMathSchema();

@extension({
  defaultPriority: ExtensionPriority.Medium,
})
export class LatexExtension extends NodeExtension {
  get name() {
    return "latex" as const;
  }
  createTags() {
    return [ExtensionTag.InlineNode];
  }
  createNodeSpec(
    extra: ApplySchemaAttributes,
    override: NodeSpecOverride
  ): NodeExtensionSpec {
    return {
      content: "text*",
      inline: true,
      atom: true,
      draggable: false,
      ...override,
      attrs: {
        ...extra.defaults(),
      },
      parseDOM: [{ tag: "math-inline" }, ...(override.parseDOM ?? [])],
      toDOM: () => ["math-inline", { class: "math-node" }, 0],
    };
  }

  createNodeViews(): NodeViewMethod | Record<string, NodeViewMethod> {
    return createMathView(false);
  }

  createPlugin(): CreateExtensionPlugin<any> {
    return mathPlugin;
  }
  createInputRules(): InputRule[] {
    return [
      nodeInputRule({
        // Allow dash + hyphen to cater for ShortcutsExtension, which replaces first
        // two hyphens with a dash, i.e. "---" becomes "<dash>-"
        regexp: /\$(.+)\$/,
        type: this.type,
      }),
    ];
  }
}

export interface HorizontalRuleOptions {
  /**
   * The name of the node to insert after inserting a horizontalRule.
   *
   * Set to false to prevent adding a node afterwards.
   *
   * @defaultValue 'paragraph'
   */
  insertionNode?: string | false;
}

@extension<HorizontalRuleOptions>({
  defaultOptions: { insertionNode: "paragraph" },
})
export class MyTestExtension extends NodeExtension<HorizontalRuleOptions> {
  get name() {
    return "horizontalRule" as const;
  }

  createTags() {
    return [ExtensionTag.Block];
  }

  createNodeSpec(
    extra: ApplySchemaAttributes,
    override: NodeSpecOverride
  ): NodeExtensionSpec {
    return {
      ...override,
      attrs: extra.defaults(),
      parseDOM: [
        { tag: "hr", getAttrs: extra.parse },
        ...(override.parseDOM ?? []),
      ],
      toDOM: (node) => ["hr", extra.dom(node)],
    };
  }
  createPlugin(): CreateExtensionPlugin<any> {
    return new ProsePlugin({
      key: new PluginKey("horizontalRulePlugin"),
      state: {
        init: (_, state) => {
          return {
            horizontalRule: false,
          };
        },
        apply(tr, value, oldState, newState) {
          return {
            horizontalRule: false,
          };
        },
      },
    });
  }
  createNodeViews(): NodeViewMethod | Record<string, NodeViewMethod> {
    return (_, view, getPos) => {
      console.log("state", this.pluginKey.getState(view.state));
      console.log("=== state 2", mathPlugin.getState(view.state));
      console.log("plugin", this.plugin, this.pluginKey, mathPlugin);
      console.log("=== state 3", this.plugin.getState(view.state));
      const dom = document.createElement("div");
      dom.style.position = "relative";

      const pos = (getPos as () => number)();
      const $pos = view.state.doc.resolve(pos + 1);

      const parentListItemNode: ProsemirrorNode | undefined = $pos.node(
        $pos.depth - 1
      );

      const isFirstLevel = parentListItemNode?.type?.name !== "listItem";

      if (!isFirstLevel) {
        const spine = document.createElement("div");
        spine.contentEditable = "false";
        spine.classList.add(ExtensionListTheme.LIST_SPINE);

        spine.addEventListener("click", (event) => {
          const pos = (getPos as () => number)();
          const $pos = view.state.doc.resolve(pos + 1);
          const parentListItemPos: number = $pos.start($pos.depth - 1);
          const selection = NodeSelection.create(
            view.state.doc,
            parentListItemPos - 1
          );
          view.dispatch(view.state.tr.setSelection(selection));
          this.store.commands.toggleListItemClosed();

          event.preventDefault();
          event.stopPropagation();
        });
        dom.append(spine);
      }

      const contentDOM = document.createElement("ul");
      contentDOM.classList.add(ExtensionListTheme.UL_LIST_CONTENT);
      dom.append(contentDOM);

      return {
        dom,
        contentDOM,
      };
    };
  }
  createInputRules(): InputRule[] {
    return [
      nodeInputRule({
        // Allow dash + hyphen to cater for ShortcutsExtension, which replaces first
        // two hyphens with a dash, i.e. "---" becomes "<dash>-"
        regexp: /^(?:===|—-|___\s|\*\*\*\s)$/,
        type: this.type,
        // beforeDispatch: ({ tr }) => {
        //   // Update to using a text selection.
        //   this.updateFromNodeSelection(tr);
        // },
      }),
    ];
  }
}
