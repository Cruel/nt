import { describe, expect, it } from 'vite-plus/test';
import { hostPathDirname, joinHostPath } from '../host-filesystem-path';

describe('host filesystem paths', () => {
  it('uses Windows separators for drive-qualified external paths', () => {
    expect(joinHostPath('C:\\Users\\Thomas\\NovelTea\\project', 'dist', 'windows-release')).toBe(
      'C:\\Users\\Thomas\\NovelTea\\project\\dist\\windows-release',
    );
    expect(joinHostPath('C:/Users/Thomas/NovelTea/project', 'assets/images/icon.png')).toBe(
      'C:\\Users\\Thomas\\NovelTea\\project\\assets\\images\\icon.png',
    );
    expect(hostPathDirname('C:\\Users\\Thomas\\NovelTea\\project.json')).toBe(
      'C:\\Users\\Thomas\\NovelTea',
    );
  });

  it('keeps POSIX external paths POSIX-native', () => {
    expect(joinHostPath('/home/thomas/project', 'dist', 'linux-release')).toBe(
      '/home/thomas/project/dist/linux-release',
    );
    expect(hostPathDirname('/home/thomas/project/project.json')).toBe('/home/thomas/project');
  });
});
