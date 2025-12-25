
import React, { useState } from 'react';
import { ChevronRight, ChevronDown, FileCode, Tag } from 'lucide-react';
import { XMLNode } from '../types';

interface XMLTreeViewProps {
  node: XMLNode;
  depth?: number;
}

const XMLTreeView: React.FC<XMLTreeViewProps> = ({ node, depth = 0 }) => {
  const [isOpen, setIsOpen] = useState(depth < 2);
  const hasChildren = node.children.length > 0;
  const hasAttributes = Object.keys(node.attributes).length > 0;

  return (
    <div className="ml-4 font-mono text-sm">
      <div 
        className={`flex items-center py-1 px-2 rounded hover:bg-slate-100 transition-colors cursor-pointer ${hasChildren ? 'text-blue-700' : 'text-slate-600'}`}
        onClick={() => hasChildren && setIsOpen(!isOpen)}
      >
        {hasChildren ? (
          isOpen ? <ChevronDown size={14} className="mr-1" /> : <ChevronRight size={14} className="mr-1" />
        ) : (
          <span className="w-[18px]" />
        )}
        <Tag size={14} className="mr-2 opacity-50" />
        <span className="font-semibold">{node.name}</span>
        
        {hasAttributes && (
          <span className="ml-2 text-[10px] text-slate-400">
            {Object.entries(node.attributes).map(([k, v]) => `${k}="${v}"`).join(' ')}
          </span>
        )}

        {!hasChildren && node.content && (
          <span className="ml-2 text-slate-900 font-normal">: {node.content}</span>
        )}
      </div>

      {isOpen && hasChildren && (
        <div className="border-l border-slate-200 ml-2 pl-2">
          {node.children.map((child, idx) => (
            <XMLTreeView key={`${child.name}-${idx}`} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
};

export default XMLTreeView;
