#define _CRT_SECURE_NO_WARNINGS
#include <stdio.h>
#include <stdlib.h>

typedef struct _pair {
	char ch;
	int line;

	_pair(char c, int l) {
		ch = c;
		line = l;
	};
	_pair() {
		ch = NULL;
		line = NULL;
	};
} pair;

typedef class _stack {
	pair data[100+1];
	pair* pnt;
public:

	_stack() {
		pnt = data;
	};

	// success : return 1
	// fail : return NULL;
	int push(char tmpch, int l) {
		if ( pnt - data < 100) {
			*pnt = pair(tmpch,l);
			++pnt;
			return 1;
		}
		else {
			printf("stack pointer out of range.");
			return NULL;
		}
	}
	pair pop() {
		if (pnt - data > 0) {
			return *(pnt--);
		}
		else {
			printf("The Stack is Empty.");
			return pair();// fail : return NULL;
		}
	}


	pair getTop() {
		if (pnt - data > 0)
			return *(pnt - 1);
		else
			return pair();// fail : return NULL;
	}

	bool isEmpty() {
		if (pnt == data) {
			return true;
		}
		else {
			return false;
		}
	}
} STACK;

int main() {
	char tmp;
	int idx=0;
	char buff[1024 * 10];
	FILE *fp = fopen("example.cpp", "r");
	if (fp == NULL) {
		printf("ERROR : failed to open txt file.");
		return -1;
	}
	printf("CPP File opened. \n");

//	STACK stack1(), stack2(), error();
	pair p;
	int line = 1;
	STACK* st = new STACK();
	STACK* err = new STACK();

	while ((tmp = fgetc(fp)) != EOF) {
		buff[idx++] = tmp;
		switch (tmp) {
		case '(' :
		case '{' :
			st->push(tmp, line);
			printf("%d  : %c\n", line,tmp);
			break;
		case ')' :
		case '}': {
			char target = tmp == ')' ? '(' : '{';
			while (!st->isEmpty()) {
				p = st->pop();
				if (p.ch != target && p.ch != NULL) {
					err->push(p.ch, p.line);
				}
				else {
					break;
				}
			}
			break;
		}
		case NULL :
			break;
		case '\n' :
			line++;
			break;
		default :
			break;
		}
	}
	buff[idx++] = NULL;
	fclose(fp);

	while ( !err->isEmpty()) {
		p= err->pop();
		printf("%c has not mathicng bracket at line %d \n", p.ch, p.line);
	}

	system("pause");
	return 0;
}